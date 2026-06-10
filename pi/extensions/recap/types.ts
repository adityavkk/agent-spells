/**
 * Shared types for the recap extension.
 *
 * The recap is a display-only "here's where we left off" summary rendered in a
 * widget above the editor when the user returns to an idle, unfocused session
 * (or on demand via /recap). Modeled on Claude Code's Session recap; see
 * ideas/recap/recap-widget.md for the verified prior art and design.
 */
import type { ModelRoleConfigTarget } from "../model-profiles/types";

/** Widget key used with ctx.ui.setWidget. */
export const RECAP_WIDGET_KEY = "recap";
/** Custom session-entry type used with pi.appendEntry (display-only persistence). */
export const RECAP_ENTRY_CUSTOM_TYPE = "recap";
/** CLI flag name (boolean): `--no-recap` disables the automatic recap for the run. */
export const RECAP_DISABLE_FLAG = "no-recap";
/** Env var: set to "0" to disable the automatic recap (mirrors CLAUDE_CODE_ENABLE_AWAY_SUMMARY). */
export const RECAP_ENABLED_ENV_VAR = "PI_RECAP_ENABLED";

/** How the automatic recap is triggered. */
export type RecapTriggerMode = "focus-idle" | "idle-timer";

/** How the transcript is summarized. */
export type RecapSummarizeMode = "delta" | "full";

/** Widget presentation style. */
export type RecapStyle = "line" | "panel";

/** Model selection config, mirroring render/answer modelSelection shape. */
export interface RecapModelSelectionConfig {
	profile?: string;
	role?: string;
	rolesByProfile?: Record<string, string>;
	roleCandidates?: string[];
	useActiveProfile?: boolean;
	fallbackToActiveRole?: boolean;
	fallbackToDefaultRole?: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: ModelRoleConfigTarget["thinkingLevel"];
	targets?: ModelRoleConfigTarget[];
	targetsByProfile?: Record<string, ModelRoleConfigTarget[]>;
}

/** Resolved recap configuration (defaults applied). */
export interface RecapConfig {
	/** Master switch for the automatic recap. /recap always works. */
	enabled: boolean;
	/** Idle time since the last completed turn before a recap can fire. */
	idleThresholdMs: number;
	/** Minimum completed turns before any recap. */
	minTurns: number;
	/** Require fresh activity (a new completed turn) between automatic recaps. */
	neverTwiceInARow: boolean;
	/** Skip the automatic recap while the editor holds unsent text. */
	suppressWhileComposing: boolean;
	/** Trigger mode. "focus-idle" auto-falls back to "idle-timer" until a focus event is seen. */
	trigger: RecapTriggerMode;
	/** Enable DECSET 1004 terminal focus reporting. */
	useFocusReporting: boolean;
	/** Model selection (model-profiles); defaults to roles ["recap", "smol", "small"]. */
	modelSelection: RecapModelSelectionConfig;
	/** Approximate cap on transcript tokens sent to the recap model. */
	maxInputTokens: number;
	/** "delta" folds new activity into the previous recap; "full" always summarizes everything. */
	summarizeMode: RecapSummarizeMode;
	/** Maximum widget lines. */
	maxLines: number;
	/** Widget style. */
	style: RecapStyle;
	/** Slash command name (collision avoidance). Applied at extension load. */
	commandName: string;
	/** Override the built-in summarization instructions. */
	prompt?: string;
	/** Append context usage ("ctx NN%") to the recap line. */
	showContextGauge: boolean;
	/** Abort recap generation after this long. */
	generationTimeoutMs: number;
	/** Debounce for focus-event flapping. */
	focusDebounceMs: number;
}

/** Terminal focus state as observed via DECSET 1004. */
export type FocusState = "focused" | "unfocused" | "unknown";

/** Pure trigger state. All transitions live in trigger.ts. */
export interface TriggerState {
	/** Completed turns observed this session runtime. */
	turnCount: number;
	/** Timestamp of the last completed turn, or null before the first one. */
	lastTurnEndAt: number | null;
	/** Current terminal focus state. */
	focus: FocusState;
	/** Whether any focus event has ever been observed (focus reporting works). */
	focusSeen: boolean;
	/** Never-twice-in-a-row latch: set when shown, cleared by fresh activity. */
	shownSinceActivity: boolean;
	/** Cached recap, keyed by transcript fingerprint. */
	cache: RecapCache | null;
	/** A cached recap is waiting for focus-in to be displayed. */
	pendingShowOnFocusIn: boolean;
}

/** A generated recap cached for display. */
export interface RecapCache {
	text: string;
	fingerprint: string;
}

/** Environment snapshot consulted by trigger decisions at evaluation time. */
export interface TriggerEnvironment {
	/** Editor has no unsent text (true when suppressWhileComposing is off). */
	editorEmpty: boolean;
	/** Agent is idle (not streaming). */
	agentIdle: boolean;
	/** No queued messages waiting. */
	hasPendingMessages: boolean;
	/** Fingerprint of the current transcript. */
	fingerprint: string;
}

/** Payload persisted via pi.appendEntry for display-only recap history. */
export interface RecapEntryData {
	text: string;
	fingerprint: string;
	/** Number of session-context messages the recap covered (delta cursor). */
	messageCount: number;
	/** Compaction entries on the branch at generation time (delta validity guard). */
	compactionCount: number;
	generatedAt: number;
	/** "auto" for the focus/idle trigger, "command" for /recap. */
	source: "auto" | "command";
}

/** Result of a recap generation attempt. */
export type RecapGenerationResult =
	| { status: "success"; text: string }
	| { status: "aborted" }
	| { status: "error"; message: string };
