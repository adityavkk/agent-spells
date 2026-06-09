/**
 * Real analyzer model runner: bridges the injected `AnalyzerRunner` contract to
 * pi-ai streaming via the shared model-profiles fallback helper.
 *
 * The analyzer model receives no tools, auth comes from the model registry
 * (never printing keys), and a timeout/abort guard ensures a slow analysis can
 * never block or mutate the main tool call.
 */
import type { Context } from "@mariozechner/pi-ai";
import {
	completeWithModelRoleFallback,
	streamWithModelRoleFallback,
} from "../model-profiles/runtime";
import type { ModelRegistryLike, ResolvedRoleResult } from "../model-profiles/types";
import type { AnalyzerRunInput, AnalyzerRunner, AnalyzerRunResult } from "./analyzer";

function textFromContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function buildContext(input: AnalyzerRunInput): Context {
	return {
		systemPrompt: input.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now() }],
		tools: [],
	};
}

function withTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
	if (timeoutMs <= 0) return { signal, cancel: () => {} };
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		cancel: () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		},
	};
}

export interface CreateModelRunnerInput {
	modelRegistry: ModelRegistryLike;
	resolved: ResolvedRoleResult;
	stream: boolean;
}

/** Create an AnalyzerRunner backed by the resolved analyzer model. */
export function createModelRunner(input: CreateModelRunnerInput): AnalyzerRunner {
	return async (run: AnalyzerRunInput): Promise<AnalyzerRunResult> => {
		const { signal, cancel } = withTimeout(run.signal, run.timeoutMs);
		const context = buildContext(run);
		try {
			if (run.signal.aborted) return { status: "aborted", text: "" };
			return input.stream
				? await runStreaming(input, context, signal, run.onDelta)
				: await runComplete(input, context, signal);
		} catch (error) {
			if (signal.aborted) return { status: "aborted", text: "" };
			return { status: "error", text: "", message: error instanceof Error ? error.message : String(error) };
		} finally {
			cancel();
		}
	};
}

async function runComplete(
	input: CreateModelRunnerInput,
	context: Context,
	signal: AbortSignal,
): Promise<AnalyzerRunResult> {
	const completion = await completeWithModelRoleFallback({
		resolved: input.resolved,
		modelRegistry: input.modelRegistry,
		context,
		buildOptions: (_candidate, auth) => ({ apiKey: auth.apiKey, headers: auth.headers, signal }),
	});
	const response = completion.response;
	if (response.stopReason === "aborted") return { status: "aborted", text: "" };
	if (response.stopReason === "error") return { status: "error", text: "", message: response.errorMessage || "analyzer error" };
	return { status: "success", text: textFromContent(response.content) };
}

async function runStreaming(
	input: CreateModelRunnerInput,
	context: Context,
	signal: AbortSignal,
	onDelta?: (text: string) => void,
): Promise<AnalyzerRunResult> {
	const stream = streamWithModelRoleFallback({
		resolved: input.resolved,
		modelRegistry: input.modelRegistry,
		context,
		buildOptions: (_candidate, auth) => ({ apiKey: auth.apiKey, headers: auth.headers, signal }),
	});
	let text = "";
	for await (const event of stream) {
		if (signal.aborted) return { status: "aborted", text };
		if (event.type === "text_delta") {
			text += event.delta;
			onDelta?.(text);
		} else if (event.type === "error") {
			return { status: "error", text, message: event.error.errorMessage || "analyzer error" };
		}
	}
	return { status: "success", text: text.trim() };
}
