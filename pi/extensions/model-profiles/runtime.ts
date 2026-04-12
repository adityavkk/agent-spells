import { complete, type Api, type AssistantMessage, type ProviderStreamOptions } from "@mariozechner/pi-ai";
import type { CompleteWithModelRoleFallbackInput, CompleteWithModelRoleFallbackResult, ModelRegistryAuthResult, RetryableModelFailureDecisionInput } from "./types";

function getFailureText(input: RetryableModelFailureDecisionInput): string {
	if (input.response?.errorMessage) return input.response.errorMessage;
	if (input.error instanceof Error) return input.error.message;
	return String(input.error ?? "");
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
