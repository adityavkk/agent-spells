/**
 * Terminal focus reporting (DECSET 1004).
 *
 * Pi does not enable focus reporting itself (verified against pi-tui and
 * pi-coding-agent), so this extension turns it on at session start and watches
 * terminal input for CSI I (focus-in) / CSI O (focus-out). The sequences are
 * stripped before the rest of the input continues to the editor.
 *
 * Input chunks arrive from pi-tui's StdinBuffer, which reassembles escape
 * sequences split across stdin reads before delivering them — a handler sees
 * complete sequences, and bracketed paste arrives as one wrapped chunk.
 * (Residual known edge: StdinBuffer flushes a partial sequence after 10ms of
 * silence; that affects all escape parsing in pi equally and is accepted.)
 * Paste chunks must be excluded from focus parsing — see isBracketedPaste —
 * so literal CSI I/O bytes inside pasted content are never eaten.
 *
 * Terminals without 1004 support never emit these sequences; the trigger
 * state machine falls back to idle-timer semantics until the first focus
 * event is observed.
 */

export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * True when the chunk is (or contains) bracketed-paste content. Such chunks
 * must bypass focus parsing entirely: pasted text may legitimately contain
 * literal focus-report bytes.
 */
export function isBracketedPaste(data: string): boolean {
	return data.includes(BRACKETED_PASTE_START) || data.includes(BRACKETED_PASTE_END);
}

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
