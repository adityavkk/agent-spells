import {
	complete,
	createAssistantMessageEventStream,
	streamSimple,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	type ProviderStreamOptions,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type {
	CompleteWithModelRoleFallbackInput,
	CompleteWithModelRoleFallbackResult,
	ModelRegistryAuthResult,
	RetryableModelFailureDecisionInput,
	StreamWithModelRoleFallbackInput,
} from "./types";

function getFailureText(input: RetryableModelFailureDecisionInput): string {
	if (input.response?.errorMessage) return input.response.errorMessage;
	if (input.error instanceof Error) return input.error.message;
	return String(input.error ?? "");
}

function createErrorResponse(model: Model<any>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function shouldCommitBufferedEvent(event: AssistantMessageEvent): boolean {
	return [
		"text_delta",
		"text_end",
		"thinking_delta",
		"thinking_end",
		"toolcall_delta",
		"toolcall_end",
	].includes(event.type);
}

function invokeAttemptStart(callback: ((candidate: any) => void) | undefined, candidate: any): void {
	if (!callback) return;
	try {
		callback(candidate);
	} catch {
		// UI/debug hooks must not break inference fallback.
	}
}

export function isRetryableModelFailure(input: RetryableModelFailureDecisionInput): boolean {
	const message = getFailureText(input).toLowerCase();
	return [
		"429",
		"too many requests",
		"rate limit",
		"throttle",
		"throttled",
		"overloaded",
		"temporarily unavailable",
		"timed out",
		"timeout",
		"connection reset",
		"econnreset",
		"terminated",
		"stream terminated",
		"connection terminated",
		"socket hang up",
		"eof",
		"unexpected eof",
		"network error",
		"upstream closed",
		"broken pipe",
		"502",
		"503",
		"504",
		"500",
		"server error",
	].some((needle) => message.includes(needle));
}

export async function completeWithModelRoleFallback<TApi extends Api = Api>(
	input: CompleteWithModelRoleFallbackInput<TApi>,
): Promise<CompleteWithModelRoleFallbackResult> {
	const completeFn = input.completeFn ?? complete<TApi>;
	const isRetryableFailure = input.isRetryableFailure ?? isRetryableModelFailure;
	const attempts: CompleteWithModelRoleFallbackResult["attempts"] = [];
	let lastResponse: AssistantMessage | undefined;
	let lastCandidate: CompleteWithModelRoleFallbackResult["candidate"] | undefined;
	let lastError: unknown;

	for (const candidate of input.resolved.candidates) {
		const auth = await input.modelRegistry.getApiKeyAndHeaders(candidate.model);
		if (!auth.ok) {
			attempts.push({
				candidate,
				status: "auth-unavailable",
				message: auth.error,
			});
			continue;
		}

		const options = input.buildOptions
			? await input.buildOptions(candidate, auth as ModelRegistryAuthResult)
			: { apiKey: auth.apiKey, headers: auth.headers } satisfies ProviderStreamOptions;

		invokeAttemptStart(input.onAttemptStart, candidate);
		try {
			const response = await completeFn(candidate.model, input.context, options);
			lastResponse = response;
			lastCandidate = candidate;
			if (response.stopReason === "error" && isRetryableFailure({ response })) {
				attempts.push({
					candidate,
					status: "retryable-response-error",
					message: response.errorMessage,
				});
				continue;
			}
			attempts.push({
				candidate,
				status: response.stopReason === "error" ? "non-retryable-response-error" : "success",
				message: response.errorMessage,
			});
			return { response, candidate, attempts };
		} catch (error) {
			lastError = error;
			if (isRetryableFailure({ error })) {
				attempts.push({
					candidate,
					status: "retryable-throw",
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			attempts.push({
				candidate,
				status: "non-retryable-throw",
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	if (lastResponse && lastCandidate) {
		return { response: lastResponse, candidate: lastCandidate, attempts };
	}
	throw lastError instanceof Error ? lastError : new Error("No model candidates available for role fallback");
}

export function streamWithModelRoleFallback<TApi extends Api = Api>(
	input: StreamWithModelRoleFallbackInput<TApi>,
) {
	const outer = createAssistantMessageEventStream();
	const streamFn = input.streamFn ?? streamSimple<TApi>;
	const isRetryableFailure = input.isRetryableFailure ?? isRetryableModelFailure;

	(async () => {
		let lastErrorMessage = "No model candidates available for role fallback";
		let lastErrorModel: Model<any> | undefined;
		const attempts: CompleteWithModelRoleFallbackResult["attempts"] = [];

		for (const candidate of input.resolved.candidates) {
			const auth = await input.modelRegistry.getApiKeyAndHeaders(candidate.model);
			if (!auth.ok) {
				lastErrorMessage = auth.error;
				lastErrorModel = candidate.model;
				attempts.push({
					candidate,
					status: "auth-unavailable",
					message: auth.error,
				});
				continue;
			}

			const options = input.buildOptions
				? await input.buildOptions(candidate, auth as ModelRegistryAuthResult)
				: { ...(input.options ?? {}), apiKey: auth.apiKey, headers: auth.headers } satisfies SimpleStreamOptions;

			invokeAttemptStart(input.onAttemptStart, candidate);
			const bufferedEvents: AssistantMessageEvent[] = [];
			let committed = false;

			try {
				const inner = streamFn(candidate.model, input.context, options);
				for await (const event of inner) {
					if (!committed && shouldCommitBufferedEvent(event)) {
						committed = true;
						for (const bufferedEvent of bufferedEvents) outer.push(bufferedEvent);
						bufferedEvents.length = 0;
					}

					if (!committed) {
						if (event.type === "done") {
							for (const bufferedEvent of bufferedEvents) outer.push(bufferedEvent);
							attempts.push({ candidate, status: "success" });
							input.onFinish?.({ status: "success", candidate, attempts });
							outer.push(event);
							outer.end();
							return;
						}
						if (event.type === "error") {
							lastErrorMessage = event.error.errorMessage ?? "Unknown provider error";
							lastErrorModel = candidate.model;
							if (isRetryableFailure({ response: event.error })) {
								attempts.push({
									candidate,
									status: "retryable-response-error",
									message: lastErrorMessage,
								});
								bufferedEvents.length = 0;
								break;
							}
							for (const bufferedEvent of bufferedEvents) outer.push(bufferedEvent);
							attempts.push({
								candidate,
								status: "non-retryable-response-error",
								message: lastErrorMessage,
							});
							input.onFinish?.({ status: "error", attempts, message: lastErrorMessage });
							outer.push(event);
							outer.end();
							return;
						}
						bufferedEvents.push(event);
						continue;
					}

					outer.push(event);
					if (event.type === "done") {
						attempts.push({ candidate, status: "success" });
						input.onFinish?.({ status: "success", candidate, attempts });
						outer.end();
						return;
					}
					if (event.type === "error") {
						lastErrorMessage = event.error.errorMessage ?? "Unknown provider error";
						attempts.push({
							candidate,
							status: "non-retryable-response-error",
							message: lastErrorMessage,
						});
						input.onFinish?.({ status: "error", attempts, message: lastErrorMessage });
						outer.end();
						return;
					}
				}
			} catch (error) {
				lastErrorMessage = error instanceof Error ? error.message : String(error);
				lastErrorModel = candidate.model;
				if (committed || !isRetryableFailure({ error })) {
					attempts.push({
						candidate,
						status: "non-retryable-throw",
						message: lastErrorMessage,
					});
					input.onFinish?.({ status: "error", attempts, message: lastErrorMessage });
					outer.push({
						type: "error",
						reason: "error",
						error: createErrorResponse(candidate.model, lastErrorMessage),
					});
					outer.end();
					return;
				}
				attempts.push({
					candidate,
					status: "retryable-throw",
					message: lastErrorMessage,
				});
			}
		}

		input.onFinish?.({ status: "error", attempts, message: lastErrorMessage });
		outer.push({
			type: "error",
			reason: "error",
			error: createErrorResponse(lastErrorModel ?? input.resolved.model, lastErrorMessage),
		});
		outer.end();
	})().catch((error) => {
		input.onFinish?.({
			status: "error",
			attempts: [],
			message: error instanceof Error ? error.message : String(error),
		});
		outer.push({
			type: "error",
			reason: "error",
			error: createErrorResponse(
				input.resolved.model,
				error instanceof Error ? error.message : String(error),
			),
		});
		outer.end();
	});

	return outer;
}
