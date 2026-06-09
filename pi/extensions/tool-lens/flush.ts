/**
 * Idle-gated card flush.
 *
 * Cards are appended to the transcript only when the agent is idle (verified:
 * appending while streaming is queued via steer/followUp and triggers an extra
 * LLM turn). Each analyzed tool call flushes exactly once, with the full record
 * in `details` and a near-empty `content` so nothing leaks even if the context
 * strip is bypassed.
 */
import { buildCardDetails } from "./store";
import type { ToolLensStore } from "./store";
import {
	TOOL_LENS_CARD_CUSTOM_TYPE,
	type ToolLensCardDetails,
	type ToolLensRecordV1,
} from "./types";

export interface CardSink {
	/** Append a custom message card. Mirrors pi.sendMessage's display/details shape. */
	send(message: { customType: string; content: string; display: boolean; details: ToolLensCardDetails }): void;
}

/** Whether a record carries enough analysis to be worth a card. */
export function isFlushable(record: ToolLensRecordV1): boolean {
	if (record.status === "not_analyzed" || record.status === "error") return true;
	return !!record.intent || !!record.outcome;
}

export interface FlushOptions {
	store: ToolLensStore;
	flushed: Set<string>;
	sink: CardSink;
	isIdle: () => boolean;
	persistCards: boolean;
}

/**
 * Flush one consolidated card per analyzed tool call in source order. No-ops if
 * cards are disabled or the agent is not idle. Returns the ids flushed.
 */
export function flushCards(options: FlushOptions): string[] {
	if (!options.persistCards || !options.isIdle()) return [];
	const flushedNow: string[] = [];
	for (const record of options.store.allSourceOrdered()) {
		if (options.flushed.has(record.toolCallId)) continue;
		if (!isFlushable(record)) continue;
		options.sink.send({
			customType: TOOL_LENS_CARD_CUSTOM_TYPE,
			content: "", // near-empty: analysis lives only in details
			display: true,
			details: buildCardDetails(record),
		});
		options.flushed.add(record.toolCallId);
		flushedNow.push(record.toolCallId);
	}
	return flushedNow;
}
