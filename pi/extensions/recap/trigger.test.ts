import { describe, expect, it } from "bun:test";
import {
	createTriggerState,
	deferShowToFocusIn,
	effectiveTriggerMode,
	invalidateCache,
	msUntilIdleThreshold,
	onActivity,
	onFocusChange,
	onGenerated,
	onShown,
	onTurnEnd,
	reseedTurns,
	shouldGenerate,
	shouldShow,
	type TriggerGateOptions,
} from "./trigger";
import type { TriggerEnvironment, TriggerState } from "./types";

const OPTIONS: TriggerGateOptions = {
	idleThresholdMs: 180_000,
	minTurns: 3,
	neverTwiceInARow: true,
	trigger: "focus-idle",
};

const T0 = 1_000_000;

function idleEnv(overrides: Partial<TriggerEnvironment> = {}): TriggerEnvironment {
	return {
		editorEmpty: true,
		agentIdle: true,
		hasPendingMessages: false,
		fingerprint: "fp-1",
		...overrides,
	};
}

/** A state that passes every generation gate in focus-idle mode. */
function readyState(): TriggerState {
	let state = createTriggerState();
	state = onTurnEnd(state, T0);
	state = onTurnEnd(state, T0);
	state = onTurnEnd(state, T0);
	state = onFocusChange(state, "unfocused");
	return state;
}

const LATER = T0 + OPTIONS.idleThresholdMs;

describe("trigger transitions", () => {
	it("counts turns and resets the never-twice latch on turn end", () => {
		let state = createTriggerState();
		state = onShown(state);
		expect(state.shownSinceActivity).toBe(true);
		state = onTurnEnd(state, T0);
		expect(state.turnCount).toBe(1);
		expect(state.lastTurnEndAt).toBe(T0);
		expect(state.shownSinceActivity).toBe(false);
	});

	it("treats aborted/errored turns as activity without counting them", () => {
		let state = deferShowToFocusIn(onShown(readyState()));
		const before = state.turnCount;
		state = onActivity(state, T0 + 1);
		expect(state.turnCount).toBe(before); // not a completed turn
		expect(state.lastTurnEndAt).toBe(T0 + 1); // but the idle clock restarts
		expect(state.shownSinceActivity).toBe(false);
		expect(state.pendingShowOnFocusIn).toBe(false);
	});

	it("drops a stale pending display on turn end", () => {
		let state = deferShowToFocusIn(readyState());
		expect(state.pendingShowOnFocusIn).toBe(true);
		state = onTurnEnd(state, T0 + 1);
		expect(state.pendingShowOnFocusIn).toBe(false);
	});

	it("reseeds turn counters from a freshly read branch", () => {
		const state = reseedTurns(readyState(), 7, T0 + 99);
		expect(state.turnCount).toBe(7);
		expect(state.lastTurnEndAt).toBe(T0 + 99);
	});

	it("records focus and marks focus reporting as seen", () => {
		let state = createTriggerState();
		expect(state.focus).toBe("unknown");
		expect(state.focusSeen).toBe(false);
		state = onFocusChange(state, "unfocused");
		expect(state.focus).toBe("unfocused");
		expect(state.focusSeen).toBe(true);
	});

	it("invalidates the cache and any pending display", () => {
		let state = onGenerated(readyState(), { text: "recap", fingerprint: "fp-1" });
		state = deferShowToFocusIn(state);
		state = invalidateCache(state);
		expect(state.cache).toBeNull();
		expect(state.pendingShowOnFocusIn).toBe(false);
	});

	it("arms the latch when shown", () => {
		let state = deferShowToFocusIn(readyState());
		state = onShown(state);
		expect(state.shownSinceActivity).toBe(true);
		expect(state.pendingShowOnFocusIn).toBe(false);
	});
});

describe("effectiveTriggerMode", () => {
	it("is idle-timer when configured as idle-timer regardless of focus", () => {
		const state = onFocusChange(createTriggerState(), "unfocused");
		expect(effectiveTriggerMode(state, { ...OPTIONS, trigger: "idle-timer" })).toBe("idle-timer");
	});

	it("falls back to idle-timer until a focus event proves 1004 works", () => {
		expect(effectiveTriggerMode(createTriggerState(), OPTIONS)).toBe("idle-timer");
		const state = onFocusChange(createTriggerState(), "focused");
		expect(effectiveTriggerMode(state, OPTIONS)).toBe("focus-idle");
	});
});

describe("msUntilIdleThreshold", () => {
	it("is null before the first completed turn", () => {
		expect(msUntilIdleThreshold(createTriggerState(), T0, OPTIONS)).toBeNull();
	});

	it("counts down from the last turn end and clamps at zero", () => {
		const state = onTurnEnd(createTriggerState(), T0);
		expect(msUntilIdleThreshold(state, T0, OPTIONS)).toBe(180_000);
		expect(msUntilIdleThreshold(state, T0 + 60_000, OPTIONS)).toBe(120_000);
		expect(msUntilIdleThreshold(state, LATER + 1, OPTIONS)).toBe(0);
	});
});

describe("shouldGenerate", () => {
	it("fires when all gates pass (unfocused, idle, enough turns)", () => {
		expect(shouldGenerate(readyState(), LATER, OPTIONS, idleEnv())).toBe(true);
	});

	it("requires the minimum turn count", () => {
		let state = createTriggerState();
		state = onTurnEnd(state, T0);
		state = onTurnEnd(state, T0);
		state = onFocusChange(state, "unfocused");
		expect(shouldGenerate(state, LATER, OPTIONS, idleEnv())).toBe(false);
	});

	it("requires the idle threshold to elapse", () => {
		expect(shouldGenerate(readyState(), LATER - 1, OPTIONS, idleEnv())).toBe(false);
	});

	it("requires the terminal to be unfocused in focus-idle mode", () => {
		const state = onFocusChange(readyState(), "focused");
		expect(shouldGenerate(state, LATER, OPTIONS, idleEnv())).toBe(false);
	});

	it("ignores focus in idle-timer mode", () => {
		const state = onFocusChange(readyState(), "focused");
		expect(shouldGenerate(state, LATER, { ...OPTIONS, trigger: "idle-timer" }, idleEnv())).toBe(true);
	});

	it("ignores focus while focus reporting has never been observed", () => {
		let state = createTriggerState();
		state = onTurnEnd(state, T0);
		state = onTurnEnd(state, T0);
		state = onTurnEnd(state, T0);
		// focus stays "unknown": auto-fallback to idle-timer semantics.
		expect(shouldGenerate(state, LATER, OPTIONS, idleEnv())).toBe(true);
	});

	it("respects the never-twice-in-a-row latch", () => {
		const state = onShown(readyState());
		expect(shouldGenerate(state, LATER, OPTIONS, idleEnv())).toBe(false);
		expect(shouldGenerate(state, LATER, { ...OPTIONS, neverTwiceInARow: false }, idleEnv())).toBe(true);
	});

	it("never generates while the agent is streaming or messages are queued", () => {
		expect(shouldGenerate(readyState(), LATER, OPTIONS, idleEnv({ agentIdle: false }))).toBe(false);
		expect(shouldGenerate(readyState(), LATER, OPTIONS, idleEnv({ hasPendingMessages: true }))).toBe(false);
	});

	it("skips generation when a recap for this exact transcript is cached", () => {
		const state = onGenerated(readyState(), { text: "recap", fingerprint: "fp-1" });
		expect(shouldGenerate(state, LATER, OPTIONS, idleEnv())).toBe(false);
		// New activity changes the fingerprint -> generate again.
		expect(shouldGenerate(state, LATER, OPTIONS, idleEnv({ fingerprint: "fp-2" }))).toBe(true);
	});

	it("does not apply the composing guard to background generation in focus-idle mode", () => {
		// A draft only blocks display; it may be gone by focus-in.
		expect(shouldGenerate(readyState(), LATER, OPTIONS, idleEnv({ editorEmpty: false }))).toBe(true);
	});

	it("applies the composing guard to generation in idle-timer mode", () => {
		// Display follows generation immediately there; a gated display would
		// waste the model call outright.
		const options: TriggerGateOptions = { ...OPTIONS, trigger: "idle-timer" };
		expect(shouldGenerate(readyState(), LATER, options, idleEnv({ editorEmpty: false }))).toBe(false);
		expect(shouldGenerate(readyState(), LATER, options, idleEnv({ editorEmpty: true }))).toBe(true);
	});
});

describe("shouldShow", () => {
	it("shows a cached recap that matches the current transcript", () => {
		const state = onGenerated(readyState(), { text: "recap", fingerprint: "fp-1" });
		expect(shouldShow(state, LATER, OPTIONS, idleEnv())).toBe(true);
	});

	it("never shows without a cache", () => {
		expect(shouldShow(readyState(), LATER, OPTIONS, idleEnv())).toBe(false);
	});

	it("drops stale recaps when the transcript moved on", () => {
		const state = onGenerated(readyState(), { text: "recap", fingerprint: "fp-old" });
		expect(shouldShow(state, LATER, OPTIONS, idleEnv({ fingerprint: "fp-new" }))).toBe(false);
	});

	it("suppresses display while composing unsent text", () => {
		const state = onGenerated(readyState(), { text: "recap", fingerprint: "fp-1" });
		expect(shouldShow(state, LATER, OPTIONS, idleEnv({ editorEmpty: false }))).toBe(false);
	});

	it("respects the never-twice latch on display", () => {
		let state = onGenerated(readyState(), { text: "recap", fingerprint: "fp-1" });
		state = onShown(state);
		expect(shouldShow(state, LATER, OPTIONS, idleEnv())).toBe(false);
	});
});
