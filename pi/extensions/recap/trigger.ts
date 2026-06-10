/**
 * Pure trigger state machine for the automatic recap.
 *
 * Mirrors Claude Code's verified gating (see ideas/recap/recap-widget.md):
 *   1. >= idleThresholdMs since the last completed turn AND terminal unfocused
 *   2. session has >= minTurns completed turns
 *   3. never twice in a row without fresh activity
 *   4. never while composing unsent text (their v2.1.113 fix, designed in)
 *
 * Generation happens on the idle edge (background, while away); display
 * happens on focus-in, so the recap is ready with zero latency on return.
 *
 * When focus reporting is unavailable (no focus event ever observed) or the
 * trigger is configured as "idle-timer", the machine degrades to: generate at
 * the idle edge regardless of focus, display immediately.
 *
 * All functions are pure: time is a parameter, side effects live in index.ts.
 */
import type { FocusState, RecapCache, TriggerEnvironment, TriggerState } from "./types";

export interface TriggerGateOptions {
	idleThresholdMs: number;
	minTurns: number;
	neverTwiceInARow: boolean;
	trigger: "focus-idle" | "idle-timer";
}

export function createTriggerState(): TriggerState {
	return {
		turnCount: 0,
		lastTurnEndAt: null,
		focus: "unknown",
		focusSeen: false,
		shownSinceActivity: false,
		cache: null,
		pendingShowOnFocusIn: false,
	};
}

/** A turn completed: fresh activity. Resets the never-twice latch. */
export function onTurnEnd(state: TriggerState, now: number): TriggerState {
	return {
		...state,
		turnCount: state.turnCount + 1,
		lastTurnEndAt: now,
		shownSinceActivity: false,
	};
}

/** A focus event was observed; focus reporting is confirmed working. */
export function onFocusChange(state: TriggerState, focus: Exclude<FocusState, "unknown">): TriggerState {
	return { ...state, focus, focusSeen: true };
}

/** Transcript changed shape out from under us (compaction, tree navigation). */
export function invalidateCache(state: TriggerState): TriggerState {
	return { ...state, cache: null, pendingShowOnFocusIn: false };
}

/** A recap finished generating for the given fingerprint. */
export function onGenerated(state: TriggerState, cache: RecapCache): TriggerState {
	return { ...state, cache };
}

/** The recap was displayed; arm the never-twice latch. */
export function onShown(state: TriggerState): TriggerState {
	return { ...state, shownSinceActivity: true, pendingShowOnFocusIn: false };
}

/** Defer display of a cached recap until the next focus-in. */
export function deferShowToFocusIn(state: TriggerState): TriggerState {
	return { ...state, pendingShowOnFocusIn: true };
}

/**
 * The effective trigger mode right now. "focus-idle" is only trustworthy once
 * a focus event has actually been observed; until then (or always, when
 * configured) the machine behaves as a plain idle timer.
 */
export function effectiveTriggerMode(state: TriggerState, options: TriggerGateOptions): "focus-idle" | "idle-timer" {
	if (options.trigger === "idle-timer") return "idle-timer";
	return state.focusSeen ? "focus-idle" : "idle-timer";
}

/**
 * Milliseconds until the idle threshold elapses, measured from the last
 * completed turn. Null when no turn has completed yet (nothing to recap).
 * Zero means the threshold has already passed.
 */
export function msUntilIdleThreshold(state: TriggerState, now: number, options: TriggerGateOptions): number | null {
	if (state.lastTurnEndAt === null) return null;
	return Math.max(0, state.lastTurnEndAt + options.idleThresholdMs - now);
}

/** Gates shared by generation and display. */
function passesCommonGates(
	state: TriggerState,
	now: number,
	options: TriggerGateOptions,
	env: TriggerEnvironment,
): boolean {
	if (state.turnCount < options.minTurns) return false;
	if (state.lastTurnEndAt === null) return false;
	if (now - state.lastTurnEndAt < options.idleThresholdMs) return false;
	if (options.neverTwiceInARow && state.shownSinceActivity) return false;
	if (!env.agentIdle) return false;
	if (env.hasPendingMessages) return false;
	return true;
}

/**
 * Should a recap be generated now (background, not yet displayed)?
 *
 * In focus-idle mode generation requires the terminal to be unfocused — the
 * whole point is to have the summary ready before the user returns. The
 * composing guard is intentionally not applied here: a draft only blocks
 * display, and it may be gone by focus-in.
 */
export function shouldGenerate(
	state: TriggerState,
	now: number,
	options: TriggerGateOptions,
	env: TriggerEnvironment,
): boolean {
	if (!passesCommonGates(state, now, options, env)) return false;
	if (state.cache?.fingerprint === env.fingerprint) return false;
	if (effectiveTriggerMode(state, options) === "focus-idle" && state.focus !== "unfocused") return false;
	return true;
}

/**
 * Should the cached recap be displayed now? Used on focus-in (focus-idle mode)
 * and right after generation (idle-timer mode, or when the user re-focused
 * while generation was still running).
 */
export function shouldShow(
	state: TriggerState,
	now: number,
	options: TriggerGateOptions,
	env: TriggerEnvironment,
): boolean {
	if (!state.cache) return false;
	if (state.cache.fingerprint !== env.fingerprint) return false;
	if (!env.editorEmpty) return false;
	return passesCommonGates(state, now, options, env);
}
