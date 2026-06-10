import { describe, expect, it } from "bun:test";
import {
	DISABLE_FOCUS_REPORTING,
	ENABLE_FOCUS_REPORTING,
	isBracketedPaste,
	lastFocusEvent,
	parseFocusEvents,
} from "./focus";

describe("focus reporting sequences", () => {
	it("uses DECSET 1004", () => {
		expect(ENABLE_FOCUS_REPORTING).toBe("\x1b[?1004h");
		expect(DISABLE_FOCUS_REPORTING).toBe("\x1b[?1004l");
	});
});

describe("parseFocusEvents", () => {
	it("passes plain keystrokes through untouched", () => {
		const result = parseFocusEvents("hello");
		expect(result.events).toEqual([]);
		expect(result.remaining).toBe("hello");
		expect(result.stripped).toBe(false);
	});

	it("parses a lone focus-in", () => {
		const result = parseFocusEvents("\x1b[I");
		expect(result.events).toEqual(["focus-in"]);
		expect(result.remaining).toBe("");
		expect(result.stripped).toBe(true);
	});

	it("parses a lone focus-out", () => {
		const result = parseFocusEvents("\x1b[O");
		expect(result.events).toEqual(["focus-out"]);
		expect(result.remaining).toBe("");
		expect(result.stripped).toBe(true);
	});

	it("strips focus events interleaved with keystrokes, preserving order and text", () => {
		const result = parseFocusEvents("\x1b[Iabc\x1b[Odef");
		expect(result.events).toEqual(["focus-in", "focus-out"]);
		expect(result.remaining).toBe("abcdef");
		expect(result.stripped).toBe(true);
	});

	it("handles multiple focus events in one chunk (alt-tab flapping)", () => {
		const result = parseFocusEvents("\x1b[O\x1b[I\x1b[O");
		expect(result.events).toEqual(["focus-out", "focus-in", "focus-out"]);
		expect(result.remaining).toBe("");
	});

	it("leaves other CSI sequences alone", () => {
		// Cursor up (\x1b[A) and a kitty-style sequence must not be consumed.
		const result = parseFocusEvents("\x1b[A\x1b[1;5C");
		expect(result.events).toEqual([]);
		expect(result.remaining).toBe("\x1b[A\x1b[1;5C");
		expect(result.stripped).toBe(false);
	});

	it("does not treat bare I/O characters as focus events", () => {
		const result = parseFocusEvents("IO[I[O");
		expect(result.events).toEqual([]);
		expect(result.remaining).toBe("IO[I[O");
	});

	it("fast-paths chunks without escape introducers", () => {
		const long = "x".repeat(1000);
		const result = parseFocusEvents(long);
		expect(result.remaining).toBe(long);
		expect(result.stripped).toBe(false);
	});
});

describe("isBracketedPaste", () => {
	it("detects paste-wrapped chunks", () => {
		expect(isBracketedPaste("\x1b[200~hello\x1b[201~")).toBe(true);
		expect(isBracketedPaste("\x1b[200~partial start only")).toBe(true);
		expect(isBracketedPaste("trailing end only\x1b[201~")).toBe(true);
	});

	it("does not flag regular input or focus reports", () => {
		expect(isBracketedPaste("hello")).toBe(false);
		expect(isBracketedPaste("\x1b[I")).toBe(false);
		expect(isBracketedPaste("\x1b[A")).toBe(false);
	});

	it("guards pasted content that contains literal focus-report bytes", () => {
		// The handler must skip focus parsing for this chunk entirely;
		// otherwise the literal \x1b[I inside the paste would be eaten.
		const paste = "\x1b[200~grep for \x1b[I in logs\x1b[201~";
		expect(isBracketedPaste(paste)).toBe(true);
	});
});

describe("lastFocusEvent", () => {
	it("returns undefined for no events", () => {
		expect(lastFocusEvent([])).toBeUndefined();
	});

	it("returns the settled state after flapping", () => {
		expect(lastFocusEvent(["focus-out", "focus-in", "focus-out"])).toBe("focus-out");
		expect(lastFocusEvent(["focus-out", "focus-in"])).toBe("focus-in");
	});
});
