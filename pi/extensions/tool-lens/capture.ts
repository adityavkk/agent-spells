/**
 * Tiered capture of tool inputs/outputs into redacted, truncated snapshots.
 *
 * Default tiers (from the design):
 *   - input:        redacted snapshot of the call args
 *   - outputSummary: redacted summary of the visible result text
 *   - toolDetails:  only for tools in `capture.toolDetailsFor` (edit/apply_patch)
 *
 * Redaction may throw on catastrophic failure; callers treat a thrown capture as
 * `redaction.onFailure: "skip"` and mark the record `not_analyzed`.
 */
import { buildRedactedPayload } from "./redaction";
import type { RedactedPayload, ToolLensConfig } from "./types";

export function captureInput(args: unknown, config: ToolLensConfig): RedactedPayload {
	return buildRedactedPayload(args, config.limits.maxInputChars, config.redaction);
}

/** Extract visible text from a tool result content array (or string). */
export function extractVisibleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
		} else if (block && typeof block === "object") {
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
			else if (record.type === "image") parts.push("[image]");
		}
	}
	return parts.join("\n");
}

export function captureOutput(content: unknown, config: ToolLensConfig): RedactedPayload {
	return buildRedactedPayload(extractVisibleText(content), config.limits.maxOutputChars, config.redaction);
}

export function shouldCaptureDetails(canonicalToolName: string, toolName: string, config: ToolLensConfig): boolean {
	const targets = config.capture.toolDetailsFor;
	return targets.includes(canonicalToolName) || targets.includes(toolName);
}

export function captureDetails(details: unknown, config: ToolLensConfig): RedactedPayload {
	return buildRedactedPayload(details, config.limits.maxOutputChars, config.redaction);
}
