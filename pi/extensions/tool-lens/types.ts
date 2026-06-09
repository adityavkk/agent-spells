/**
 * Shared types for the tool-lens extension: config, persisted analysis records,
 * and the per-tool state machine.
 *
 * The persisted payload is versioned (`tool-lens.analysis.v1`) and read back
 * through a tolerant normalizer so older/newer sessions degrade gracefully.
 */
import type { ModelRoleConfigTarget } from "../model-profiles/types";

export const TOOL_LENS_CONFIG_FILENAME = "tool-lens.json";
export const TOOL_LENS_ANALYSIS_SCHEMA = "tool-lens.analysis.v1";

/** Custom message type used for persisted lens cards. */
export const TOOL_LENS_CARD_CUSTOM_TYPE = "tool-lens";
/** Custom entry type used for hidden per-phase audit entries. */
export const TOOL_LENS_AUDIT_CUSTOM_TYPE = "tool-lens-audit";
/** Footer status key. */
export const TOOL_LENS_STATUS_KEY = "tool-lens";
/** Live HUD widget key. */
export const TOOL_LENS_HUD_KEY = "tool-lens";

export type ToolLensVisibility = "full" | "compact" | "hidden";
export type ToolLensPhase = "intent" | "outcome";
export type ToolLensMode = "intent-only" | "outcome-only" | "intent-and-outcome";

export type ToolLensStatus =
	| "observed"
	| "intent_streaming"
	| "executing"
	| "outcome_streaming"
	| "done"
	| "error"
	| "not_analyzed";

/** A redacted/truncated snapshot of tool input or output. */
export interface RedactedPayload {
	/** Redacted, truncated text safe to render and send to the analyzer. */
	text: string;
	/** Whether redaction removed at least one secret-like span. */
	redacted: boolean;
	/** Whether the text was truncated past the configured limit. */
	truncated: boolean;
	/** Original character length before truncation (after redaction). */
	originalChars: number;
}

export interface ToolLensIntent {
	/** What the tool call is trying to accomplish. */
	intent: string;
	/** What visible session context makes this call useful. */
	whyNow?: string;
	/** What a useful result would look like. */
	expected?: string;
	/** Risk, ambiguity, or likely failure mode. */
	watch?: string;
}

export interface ToolLensOutcome {
	/** What happened. */
	result: string;
	/** Whether the result matched the inferred intent. */
	matched: "yes" | "no" | "partial" | "unknown";
	/** Outputs, errors, files changed, counts, truncation. */
	importantDetails?: string;
	/** What the main agent likely should do next. */
	implication?: string;
}

/**
 * Versioned analysis record. Written to per-phase audit entries (with `phase`
 * set) during a run, and consolidated (no `phase`) into card `details` at idle.
 */
export interface ToolLensRecordV1 {
	schema: typeof TOOL_LENS_ANALYSIS_SCHEMA;
	/** Sole correlation key across events, audit entries, and cards. */
	toolCallId: string;
	turnIndex: number;
	/** Assistant source index, for stable source-order display. */
	sourceOrder: number;
	/** Tool name as called by the model. */
	toolName: string;
	/** Alias-normalized tool name (e.g. shell_command -> bash). */
	canonicalToolName?: string;
	/** Set on audit entries; omitted on the consolidated card. */
	phase?: ToolLensPhase;
	startedAt: number;
	completedAt?: number;
	input?: RedactedPayload;
	outputSummary?: RedactedPayload;
	/** Only captured for edit/apply_patch by default. */
	toolDetails?: RedactedPayload;
	intent?: ToolLensIntent;
	outcome?: ToolLensOutcome;
	status: ToolLensStatus;
	errors?: string[];
}

export interface ToolLensCardDetails {
	record: ToolLensRecordV1;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ToolLensToolsConfig {
	allowList: string[];
	blockList: string[];
	aliases: Record<string, string>;
}

export interface ToolLensModelSelectionConfig {
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

export interface ToolLensAnalysisConfig {
	maxConcurrentAnalyses: number;
	lateMerge: boolean;
	stream: boolean;
	timeoutMs: number;
}

export interface ToolLensContextConfig {
	maxMessages: number;
	maxChars: number;
	includeSystemPrompt: boolean;
	includeContextFiles: boolean;
	includePriorToolResults: boolean;
}

export interface ToolLensCaptureConfig {
	/** Tool names (canonical) for which tool details are captured. */
	toolDetailsFor: string[];
}

export interface ToolLensRedactionConfig {
	enabled: boolean;
	redactEnvLikeValues: boolean;
	/** What to do if redaction throws: skip the model call (mark not_analyzed). */
	onFailure: "skip";
	extraPatterns: string[];
}

export interface ToolLensLimitsConfig {
	maxInputChars: number;
	maxOutputChars: number;
	maxAnalysesPerTurn: number;
}

export interface ToolLensRenderingConfig {
	liveHud: boolean;
	hudMaxRows: number;
	persistCards: boolean;
	stripFromContext: boolean;
	defaultVisibility: ToolLensVisibility;
	visibilityCycle: ToolLensVisibility[];
	toggleShortcut: string;
	expandedByDefault: boolean;
}

export interface ToolLensConfig {
	enabled: boolean;
	mode: ToolLensMode;
	tools: ToolLensToolsConfig;
	modelSelection: ToolLensModelSelectionConfig;
	analysis: ToolLensAnalysisConfig;
	context: ToolLensContextConfig;
	capture: ToolLensCaptureConfig;
	redaction: ToolLensRedactionConfig;
	limits: ToolLensLimitsConfig;
	rendering: ToolLensRenderingConfig;
}

export interface ToolLensConfigError {
	path: string;
	message: string;
}

export interface LoadedToolLensConfig {
	globalPath: string;
	projectPath: string;
	mergedConfig: ToolLensConfig;
	errors: ToolLensConfigError[];
}
