/**
 * Tolerant normalizer for persisted tool-lens records.
 *
 * Sessions written by older or newer versions of the extension are read back
 * through `normalizeRecord`: unknown fields are ignored and missing fields fall
 * back to safe defaults (`unknown`), mirroring the render/answer extensions.
 */
import {
	TOOL_LENS_ANALYSIS_SCHEMA,
	type RedactedPayload,
	type ToolLensIntent,
	type ToolLensOutcome,
	type ToolLensPhase,
	type ToolLensRecordV1,
	type ToolLensStatus,
} from "./types";

const STATUS_VALUES: ToolLensStatus[] = [
	"observed",
	"intent_streaming",
	"executing",
	"outcome_streaming",
	"done",
	"error",
	"not_analyzed",
];

const MATCHED_VALUES: ToolLensOutcome["matched"][] = ["yes", "no", "partial", "unknown"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.map(asString).filter((item): item is string => !!item);
	return result.length > 0 ? result : undefined;
}

function normalizePayload(value: unknown): RedactedPayload | undefined {
	if (!isRecord(value)) return undefined;
	const text = typeof value.text === "string" ? value.text : "";
	return {
		text,
		redacted: value.redacted === true,
		truncated: value.truncated === true,
		originalChars: asNumber(value.originalChars) ?? text.length,
	};
}

function normalizeIntent(value: unknown): ToolLensIntent | undefined {
	if (!isRecord(value)) return undefined;
	const intent = asString(value.intent);
	if (!intent) return undefined;
	return {
		intent,
		whyNow: asString(value.whyNow),
		expected: asString(value.expected),
		watch: asString(value.watch),
	};
}

function normalizeOutcome(value: unknown): ToolLensOutcome | undefined {
	if (!isRecord(value)) return undefined;
	const result = asString(value.result);
	if (!result) return undefined;
	const matchedRaw = asString(value.matched) as ToolLensOutcome["matched"] | undefined;
	return {
		result,
		matched: matchedRaw && MATCHED_VALUES.includes(matchedRaw) ? matchedRaw : "unknown",
		importantDetails: asString(value.importantDetails),
		implication: asString(value.implication),
	};
}

function normalizePhase(value: unknown): ToolLensPhase | undefined {
	const text = asString(value);
	return text === "intent" || text === "outcome" ? text : undefined;
}

function normalizeStatus(value: unknown): ToolLensStatus {
	const text = asString(value) as ToolLensStatus | undefined;
	return text && STATUS_VALUES.includes(text) ? text : "observed";
}

/**
 * Coerce arbitrary persisted data into a `ToolLensRecordV1`. Returns null only
 * when the minimum identity (`toolCallId`) is missing.
 */
export function normalizeRecord(value: unknown): ToolLensRecordV1 | null {
	if (!isRecord(value)) return null;
	const toolCallId = asString(value.toolCallId);
	if (!toolCallId) return null;
	return {
		schema: TOOL_LENS_ANALYSIS_SCHEMA,
		toolCallId,
		turnIndex: asNumber(value.turnIndex) ?? 0,
		sourceOrder: asNumber(value.sourceOrder) ?? 0,
		toolName: asString(value.toolName) ?? "unknown",
		canonicalToolName: asString(value.canonicalToolName),
		phase: normalizePhase(value.phase),
		startedAt: asNumber(value.startedAt) ?? 0,
		completedAt: asNumber(value.completedAt),
		input: normalizePayload(value.input),
		outputSummary: normalizePayload(value.outputSummary),
		toolDetails: normalizePayload(value.toolDetails),
		intent: normalizeIntent(value.intent),
		outcome: normalizeOutcome(value.outcome),
		status: normalizeStatus(value.status),
		errors: asStringArray(value.errors),
	};
}
