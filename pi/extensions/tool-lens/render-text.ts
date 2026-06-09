/**
 * Pure text builders for the live HUD and persisted cards.
 *
 * These return plain strings/lines with no terminal styling so they can be unit
 * tested deterministically. The TUI components in `ui.ts` add theme colors and
 * wrap these in `Text`. Display order is always source order; the caller sorts.
 */
import type { ToolLensRecordV1, ToolLensStatus, ToolLensVisibility } from "./types";

const STATUS_GLYPH: Record<ToolLensStatus, string> = {
	observed: "·",
	intent_streaming: "◍",
	executing: "▸",
	outcome_streaming: "◍",
	done: "✓",
	error: "✗",
	not_analyzed: "—",
};

const MATCHED_GLYPH: Record<NonNullable<ToolLensRecordV1["outcome"]>["matched"], string> = {
	yes: "matched",
	no: "mismatch",
	partial: "partial",
	unknown: "matched?",
};

export function displayName(record: ToolLensRecordV1): string {
	return record.canonicalToolName ?? record.toolName;
}

function statusWord(record: ToolLensRecordV1): string {
	switch (record.status) {
		case "intent_streaming":
			return "intent…";
		case "executing":
			return "running";
		case "outcome_streaming":
			return "outcome…";
		case "done":
			return record.outcome ? MATCHED_GLYPH[record.outcome.matched] : "done";
		case "error":
			return "error";
		case "not_analyzed":
			return "not analyzed";
		default:
			return "observed";
	}
}

/** One compact HUD row per tool call: "A read intent… matched". */
export function hudRow(record: ToolLensRecordV1, index: number): string {
	const tag = String.fromCharCode(65 + (index % 26));
	const glyph = STATUS_GLYPH[record.status];
	const intent = record.intent?.intent ? ` ${truncateInline(record.intent.intent, 48)}` : "";
	return `${tag} ${glyph} ${displayName(record)}  ${statusWord(record)}${intent}`.trimEnd();
}

export function hudLines(records: ToolLensRecordV1[], turnIndex: number, maxRows: number): string[] {
	const header = `tool-lens · turn ${turnIndex}`;
	if (records.length === 0) return [header, "(waiting for tool calls)"];
	const rows = records.slice(0, Math.max(1, maxRows)).map((record, index) => hudRow(record, index));
	const overflow = records.length > maxRows ? [`… +${records.length - maxRows} more`] : [];
	return [header, ...rows, ...overflow];
}

/** One-line compact summary of a whole batch for the compact HUD/visibility. */
export function hudCompactLine(records: ToolLensRecordV1[]): string {
	const analyzed = records.filter((r) => r.status === "done").length;
	const errors = records.filter((r) => r.status === "error").length;
	const running = records.filter((r) => r.status === "executing" || r.status === "outcome_streaming" || r.status === "intent_streaming").length;
	const parts = [`${records.length} calls`, `${analyzed} analyzed`];
	if (running > 0) parts.push(`${running} active`);
	if (errors > 0) parts.push(`${errors} errors`);
	return `tool-lens: ${parts.join(", ")}`;
}

function truncateInline(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function fieldLine(label: string, value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? `${label}: ${text}` : undefined;
}

/** Lines for a persisted card given the current visibility and expand state. */
export function cardLines(record: ToolLensRecordV1, visibility: ToolLensVisibility, expanded: boolean): string[] {
	if (visibility === "hidden") {
		// CustomMessageComponent always prepends one Spacer, so this is a one-line stub.
		return [`lens ${displayName(record)} (hidden)`];
	}

	const title = `lens  ${displayName(record)}`;
	if (visibility === "compact") {
		return [`${title}  ${cardCompactSummary(record)}`];
	}

	// full
	const lines: string[] = [title];
	if (!expanded) {
		const summary = cardCompactSummary(record);
		if (summary) lines.push(summary);
		return lines;
	}

	const intent = record.intent;
	const outcome = record.outcome;
	for (const line of [
		fieldLine("intent", intent?.intent),
		fieldLine("why now", intent?.whyNow),
		fieldLine("expected", intent?.expected),
		fieldLine("watch", intent?.watch),
		fieldLine("outcome", outcome ? `${outcome.result} (${MATCHED_GLYPH[outcome.matched]})` : undefined),
		fieldLine("details", outcome?.importantDetails),
		fieldLine("implication", outcome?.implication),
	]) {
		if (line) lines.push(line);
	}
	if (record.status === "not_analyzed") lines.push(notAnalyzedReason(record));
	if (record.status === "error" && record.errors?.length) lines.push(`error: ${record.errors[record.errors.length - 1]}`);
	if (lines.length === 1) lines.push("(no analysis)");
	return lines;
}

function cardCompactSummary(record: ToolLensRecordV1): string {
	if (record.status === "not_analyzed") return notAnalyzedReason(record);
	const intent = record.intent?.intent ? truncateInline(record.intent.intent, 60) : undefined;
	const matched = record.outcome ? MATCHED_GLYPH[record.outcome.matched] : undefined;
	if (intent && matched) return `${intent} · ${matched}`;
	if (intent) return intent;
	if (matched) return matched;
	return statusWord(record);
}

function notAnalyzedReason(record: ToolLensRecordV1): string {
	const reason = record.errors?.[record.errors.length - 1];
	return reason ? `not analyzed: ${reason}` : "not analyzed";
}
