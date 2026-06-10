/**
 * Terminal focus reporting (DECSET 1004).
 *
 * Pi does not enable focus reporting itself (verified against pi-tui and
 * pi-coding-agent), so this extension turns it on at session start and watches
 * raw terminal input for CSI I (focus-in) / CSI O (focus-out). The sequences
 * are stripped before the rest of the input continues to the editor.
 *
 * Terminals without 1004 support simply never emit these sequences; the
 * trigger state machine falls back to idle-timer semantics until the first
 * focus event is observed.
 */

export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

export type FocusEvent = "focus-in" | "focus-out";

export interface FocusParseResult {
	/** Focus events found in the chunk, in order. */
	events: FocusEvent[];
	/** The chunk with focus sequences removed. */
	remaining: string;
	/** True when at least one sequence was stripped. */
	stripped: boolean;
}

/**
 * Extract focus events from a raw terminal input chunk.
 *
 * Chunks can contain multiple sequences and can interleave focus reports with
 * regular keystrokes (e.g. alt-tab back followed by immediate typing), so the
 * parser strips every occurrence and preserves the rest verbatim.
 */
export function parseFocusEvents(data: string): FocusParseResult {
	if (!data.includes("\x1b[")) {
		return { events: [], remaining: data, stripped: false };
	}
	const events: FocusEvent[] = [];
	let remaining = "";
	let index = 0;
	while (index < data.length) {
		if (data.startsWith(FOCUS_IN, index)) {
			events.push("focus-in");
			index += FOCUS_IN.length;
			continue;
		}
		if (data.startsWith(FOCUS_OUT, index)) {
			events.push("focus-out");
			index += FOCUS_OUT.length;
			continue;
		}
		remaining += data[index];
		index += 1;
	}
	return { events, remaining, stripped: events.length > 0 };
}

/** The focus state implied by the last event in a chunk, if any. */
export function lastFocusEvent(events: readonly FocusEvent[]): FocusEvent | undefined {
	return events.length > 0 ? events[events.length - 1] : undefined;
}
