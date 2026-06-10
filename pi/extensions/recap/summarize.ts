/**
 * Recap generation: prompt construction and the cheap-model completion.
 *
 * Uses completeWithModelRoleFallback (same path as render/answer/tool-lens)
 * with a hard timeout so a slow model can never wedge the trigger machinery.
 * All failures are returned as values — the caller decides whether to stay
 * silent (automatic path) or notify (/recap).
 */
import type { Context } from "@mariozechner/pi-ai";
import { completeWithModelRoleFallback } from "../model-profiles/runtime";
import type {
	CompleteWithModelRoleFallbackInput,
	ModelRegistryLike,
	ResolvedRoleResult,
} from "../model-profiles/types";
import type { RecapGenerationResult } from "./types";

export const DEFAULT_RECAP_SYSTEM_PROMPT = [
	"You write a one-line session recap for a coding agent's terminal UI.",
	"The user stepped away mid-session and needs to re-orient in one glance.",
	"Summarize: what was being worked on, the latest state or result, and the next step if one is clear.",
	"Respond with ONLY the recap line - plain text, no markdown, no quotes, no preamble, at most 200 characters.",
].join(" ");

export interface BuildRecapContextInput {
	/** Plain-text transcript digest (see transcript.ts). */
	digest: string;
	/** Previous recap text for delta mode; new activity is folded into it. */
	previousRecap?: string;
	/** Override the built-in instructions. */
	systemPrompt?: string;
}

export function buildRecapContext(input: BuildRecapContextInput): Context {
	const sections: string[] = [];
	if (input.previousRecap) {
		sections.push(`Previous recap (the session so far):\n${input.previousRecap}`);
		sections.push(`New activity since that recap:\n${input.digest}`);
		sections.push("Update the recap to cover the whole session, weighting the newest activity.");
	} else {
		sections.push(`Session transcript digest:\n${input.digest}`);
	}
	return {
		systemPrompt: input.systemPrompt ?? DEFAULT_RECAP_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: sections.join("\n\n") }],
				timestamp: Date.now(),
			},
		],
		tools: [],
	};
}

/** Combine an outer signal with a timeout into one AbortSignal (tool-lens pattern). */
function withTimeout(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	if (outer) {
		if (outer.aborted) controller.abort();
		else outer.addEventListener("abort", onAbort, { once: true });
	}
	const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
	return {
		signal: controller.signal,
		cancel: () => {
			if (timer !== undefined) clearTimeout(timer);
			outer?.removeEventListener("abort", onAbort);
		},
	};
}

function textFromResponseContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Strip model decoration the prompt forbids but small models still emit. */
export function sanitizeRecapText(raw: string): string {
	let text = raw.trim();
	const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
	text = firstLine.trim();
	if (
		(text.startsWith('"') && text.endsWith('"') && text.length > 1) ||
		(text.startsWith("'") && text.endsWith("'") && text.length > 1)
	) {
		text = text.slice(1, -1).trim();
	}
	text = text.replace(/^recap:\s*/i, "");
	return text;
}

export interface RunRecapCompletionInput {
	resolved: ResolvedRoleResult;
	modelRegistry: ModelRegistryLike;
	context: Context;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Test seam: injected completion function. */
	completeFn?: CompleteWithModelRoleFallbackInput["completeFn"];
}

export async function runRecapCompletion(input: RunRecapCompletionInput): Promise<RecapGenerationResult> {
	const { signal, cancel } = withTimeout(input.timeoutMs, input.signal);
	try {
		const completion = await completeWithModelRoleFallback({
			resolved: input.resolved,
			modelRegistry: input.modelRegistry,
			context: input.context,
			completeFn: input.completeFn,
			buildOptions: (_candidate, auth) => ({
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal,
			}),
		});
		const response = completion.response;
		if (response.stopReason === "aborted") return { status: "aborted" };
		if (response.stopReason === "error") {
			return { status: "error", message: response.errorMessage || "recap generation failed" };
		}
		const text = sanitizeRecapText(textFromResponseContent(response.content));
		if (!text) return { status: "error", message: "recap model returned no text" };
		return { status: "success", text };
	} catch (error) {
		if (signal.aborted) return { status: "aborted" };
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	} finally {
		cancel();
	}
}

/** Human-readable provider/model label for notifications. */
export function describeResolvedModel(resolved: ResolvedRoleResult): string {
	return `${resolved.ref.provider}/${resolved.ref.model}`;
}
