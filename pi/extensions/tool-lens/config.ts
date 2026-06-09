/**
 * Declarative config for tool-lens.
 *
 * Loads a global file (`~/.pi/agent/tool-lens.json`) and a project file
 * (`.pi/tool-lens.json`), with the project file winning. Env vars provide
 * escape hatches applied last:
 *   - PI_TOOL_LENS=0            disable entirely
 *   - PI_TOOL_LENS_RENDER=...   override default visibility (full|compact|hidden)
 *   - PI_TOOL_LENS_HUD=0        disable the live HUD
 *   - PI_TOOL_LENS_CARDS=0      disable persisted cards
 *
 * Normalization is tolerant: unknown fields are ignored and missing fields fall
 * back to defaults, mirroring the render / provider-tool-profiles extensions.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRoleConfigTarget } from "../model-profiles/types";
import {
	TOOL_LENS_CONFIG_FILENAME,
	type LoadedToolLensConfig,
	type ToolLensConfig,
	type ToolLensConfigError,
	type ToolLensMode,
	type ToolLensModelSelectionConfig,
	type ToolLensVisibility,
} from "./types";

const VISIBILITY_VALUES: ToolLensVisibility[] = ["full", "compact", "hidden"];
const MODE_VALUES: ToolLensMode[] = ["intent-only", "outcome-only", "intent-and-outcome"];

export const DEFAULT_TOOL_LENS_CONFIG: ToolLensConfig = {
	enabled: true,
	mode: "intent-and-outcome",
	tools: {
		allowList: ["*"],
		blockList: [],
		aliases: {
			shell_command: "bash",
			run_shell_command: "bash",
			read_file: "read",
			read_many_files: "read",
			apply_patch: "edit",
			replace: "edit",
			write_file: "write",
			search_file_content: "grep",
			grep_search: "grep",
			list_directory: "ls",
		},
	},
	modelSelection: {},
	analysis: {
		maxConcurrentAnalyses: 2,
		lateMerge: true,
		stream: true,
		timeoutMs: 20000,
	},
	context: {
		maxMessages: 8,
		maxChars: 12000,
		includeSystemPrompt: false,
		includeContextFiles: false,
		includePriorToolResults: true,
	},
	capture: {
		toolDetailsFor: ["edit", "apply_patch"],
	},
	redaction: {
		enabled: true,
		redactEnvLikeValues: true,
		onFailure: "skip",
		extraPatterns: [],
	},
	limits: {
		maxInputChars: 4000,
		maxOutputChars: 8000,
		maxAnalysesPerTurn: 24,
	},
	rendering: {
		liveHud: true,
		hudMaxRows: 8,
		persistCards: true,
		stripFromContext: true,
		defaultVisibility: "full",
		visibilityCycle: ["full", "compact", "hidden"],
		toggleShortcut: "ctrl+l",
		expandedByDefault: false,
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const rounded = Math.floor(value);
	return rounded >= 0 ? rounded : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		const text = normalizeString(item);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		result.push(text);
	}
	return result.length > 0 ? result : undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const normalizedKey = normalizeString(key);
		const normalizedValue = normalizeString(raw);
		if (!normalizedKey || !normalizedValue) continue;
		result[normalizedKey] = normalizedValue;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeVisibility(value: unknown): ToolLensVisibility | undefined {
	const text = normalizeString(value)?.toLowerCase();
	return text && (VISIBILITY_VALUES as string[]).includes(text) ? (text as ToolLensVisibility) : undefined;
}

function normalizeVisibilityCycle(value: unknown): ToolLensVisibility[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<ToolLensVisibility>();
	const result: ToolLensVisibility[] = [];
	for (const item of value) {
		const visibility = normalizeVisibility(item);
		if (!visibility || seen.has(visibility)) continue;
		seen.add(visibility);
		result.push(visibility);
	}
	return result.length > 0 ? result : undefined;
}

function normalizeMode(value: unknown): ToolLensMode | undefined {
	const text = normalizeString(value)?.toLowerCase();
	return text && (MODE_VALUES as string[]).includes(text) ? (text as ToolLensMode) : undefined;
}

function normalizeRoleTarget(value: unknown): ModelRoleConfigTarget | undefined {
	if (!isRecord(value)) return undefined;
	const provider = normalizeString(value.provider);
	const model = normalizeString(value.model);
	const thinkingLevel = normalizeString(value.thinkingLevel) as ModelRoleConfigTarget["thinkingLevel"] | undefined;
	if (!provider || !model) return undefined;
	return { provider, model, thinkingLevel };
}

function normalizeRoleTargets(value: unknown): ModelRoleConfigTarget[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const targets = value.map(normalizeRoleTarget).filter((item): item is ModelRoleConfigTarget => !!item);
	return targets.length > 0 ? targets : undefined;
}

function normalizeTargetsByProfile(value: unknown): Record<string, ModelRoleConfigTarget[]> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, ModelRoleConfigTarget[]> = {};
	for (const [key, raw] of Object.entries(value)) {
		const normalizedKey = normalizeString(key);
		const targets = normalizeRoleTargets(raw);
		if (!normalizedKey || !targets) continue;
		result[normalizedKey] = targets;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeModelSelection(value: unknown): ToolLensModelSelectionConfig {
	if (!isRecord(value)) return {};
	return {
		profile: normalizeString(value.profile),
		role: normalizeString(value.role),
		rolesByProfile: normalizeStringMap(value.rolesByProfile),
		roleCandidates: normalizeStringArray(value.roleCandidates),
		useActiveProfile: normalizeBoolean(value.useActiveProfile),
		fallbackToActiveRole: normalizeBoolean(value.fallbackToActiveRole),
		fallbackToDefaultRole: normalizeBoolean(value.fallbackToDefaultRole),
		provider: normalizeString(value.provider),
		model: normalizeString(value.model),
		thinkingLevel: normalizeString(value.thinkingLevel) as ModelRoleConfigTarget["thinkingLevel"] | undefined,
		targets: normalizeRoleTargets(value.targets),
		targetsByProfile: normalizeTargetsByProfile(value.targetsByProfile),
	};
}

/**
 * Deep-merge a raw config object onto a base, validating field types. Unknown
 * fields are dropped; invalid-typed fields fall back to the base value.
 */
export function mergeToolLensConfig(base: ToolLensConfig, raw: unknown): ToolLensConfig {
	if (!isRecord(raw)) return base;
	const tools = isRecord(raw.tools) ? raw.tools : {};
	const analysis = isRecord(raw.analysis) ? raw.analysis : {};
	const context = isRecord(raw.context) ? raw.context : {};
	const capture = isRecord(raw.capture) ? raw.capture : {};
	const redaction = isRecord(raw.redaction) ? raw.redaction : {};
	const limits = isRecord(raw.limits) ? raw.limits : {};
	const rendering = isRecord(raw.rendering) ? raw.rendering : {};

	return {
		enabled: normalizeBoolean(raw.enabled) ?? base.enabled,
		mode: normalizeMode(raw.mode) ?? base.mode,
		tools: {
			allowList: normalizeStringArray(tools.allowList) ?? base.tools.allowList,
			blockList: normalizeStringArray(tools.blockList) ?? base.tools.blockList,
			aliases: { ...base.tools.aliases, ...(normalizeStringMap(tools.aliases) ?? {}) },
		},
		modelSelection: { ...base.modelSelection, ...normalizeModelSelection(raw.modelSelection) },
		analysis: {
			maxConcurrentAnalyses: normalizePositiveInt(analysis.maxConcurrentAnalyses) ?? base.analysis.maxConcurrentAnalyses,
			lateMerge: normalizeBoolean(analysis.lateMerge) ?? base.analysis.lateMerge,
			stream: normalizeBoolean(analysis.stream) ?? base.analysis.stream,
			timeoutMs: normalizePositiveInt(analysis.timeoutMs) ?? base.analysis.timeoutMs,
		},
		context: {
			maxMessages: normalizePositiveInt(context.maxMessages) ?? base.context.maxMessages,
			maxChars: normalizePositiveInt(context.maxChars) ?? base.context.maxChars,
			includeSystemPrompt: normalizeBoolean(context.includeSystemPrompt) ?? base.context.includeSystemPrompt,
			includeContextFiles: normalizeBoolean(context.includeContextFiles) ?? base.context.includeContextFiles,
			includePriorToolResults: normalizeBoolean(context.includePriorToolResults) ?? base.context.includePriorToolResults,
		},
		capture: {
			toolDetailsFor: normalizeStringArray(capture.toolDetailsFor) ?? base.capture.toolDetailsFor,
		},
		redaction: {
			enabled: normalizeBoolean(redaction.enabled) ?? base.redaction.enabled,
			redactEnvLikeValues: normalizeBoolean(redaction.redactEnvLikeValues) ?? base.redaction.redactEnvLikeValues,
			onFailure: "skip",
			extraPatterns: normalizeStringArray(redaction.extraPatterns) ?? base.redaction.extraPatterns,
		},
		limits: {
			maxInputChars: normalizePositiveInt(limits.maxInputChars) ?? base.limits.maxInputChars,
			maxOutputChars: normalizePositiveInt(limits.maxOutputChars) ?? base.limits.maxOutputChars,
			maxAnalysesPerTurn: normalizePositiveInt(limits.maxAnalysesPerTurn) ?? base.limits.maxAnalysesPerTurn,
		},
		rendering: {
			liveHud: normalizeBoolean(rendering.liveHud) ?? base.rendering.liveHud,
			hudMaxRows: normalizePositiveInt(rendering.hudMaxRows) ?? base.rendering.hudMaxRows,
			persistCards: normalizeBoolean(rendering.persistCards) ?? base.rendering.persistCards,
			stripFromContext: normalizeBoolean(rendering.stripFromContext) ?? base.rendering.stripFromContext,
			defaultVisibility: normalizeVisibility(rendering.defaultVisibility) ?? base.rendering.defaultVisibility,
			visibilityCycle: normalizeVisibilityCycle(rendering.visibilityCycle) ?? base.rendering.visibilityCycle,
			toggleShortcut: normalizeString(rendering.toggleShortcut) ?? base.rendering.toggleShortcut,
			expandedByDefault: normalizeBoolean(rendering.expandedByDefault) ?? base.rendering.expandedByDefault,
		},
	};
}

export function applyToolLensEnvOverrides(
	config: ToolLensConfig,
	env: NodeJS.ProcessEnv = process.env,
): ToolLensConfig {
	const next: ToolLensConfig = {
		...config,
		rendering: { ...config.rendering },
	};
	const enabled = env.PI_TOOL_LENS?.trim().toLowerCase();
	if (enabled === "0" || enabled === "false") next.enabled = false;

	const render = normalizeVisibility(env.PI_TOOL_LENS_RENDER);
	if (render) next.rendering.defaultVisibility = render;

	const hud = env.PI_TOOL_LENS_HUD?.trim().toLowerCase();
	if (hud === "0" || hud === "false") next.rendering.liveHud = false;

	const cards = env.PI_TOOL_LENS_CARDS?.trim().toLowerCase();
	if (cards === "0" || cards === "false") next.rendering.persistCards = false;

	return next;
}

export function getGlobalToolLensConfigPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, TOOL_LENS_CONFIG_FILENAME);
}

export function getProjectToolLensConfigPath(cwd: string): string {
	return join(cwd, ".pi", TOOL_LENS_CONFIG_FILENAME);
}

function readConfigFile(path: string, errors: ToolLensConfigError[]): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		errors.push({ path, message: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
}

export function loadToolLensConfig(
	cwd: string,
	agentDir?: string,
	env: NodeJS.ProcessEnv = process.env,
): LoadedToolLensConfig {
	const errors: ToolLensConfigError[] = [];
	const globalPath = getGlobalToolLensConfigPath(agentDir);
	const projectPath = getProjectToolLensConfigPath(cwd);
	const globalRaw = readConfigFile(globalPath, errors);
	const projectRaw = readConfigFile(projectPath, errors);

	let merged = mergeToolLensConfig(DEFAULT_TOOL_LENS_CONFIG, globalRaw);
	merged = mergeToolLensConfig(merged, projectRaw);
	merged = applyToolLensEnvOverrides(merged, env);

	return { globalPath, projectPath, mergedConfig: merged, errors };
}

/**
 * Resolve the canonical tool name (after alias normalization) and whether the
 * tool is observed given allow/block lists. Block list wins; matching is on the
 * canonical name. "*" in the allow list matches everything.
 */
export function resolveToolObservation(
	toolName: string,
	tools: ToolLensConfig["tools"],
): { canonicalToolName: string; observed: boolean } {
	const canonicalToolName = tools.aliases[toolName] ?? toolName;
	if (tools.blockList.includes(canonicalToolName) || tools.blockList.includes(toolName)) {
		return { canonicalToolName, observed: false };
	}
	const allowAll = tools.allowList.includes("*");
	const allowed = allowAll || tools.allowList.includes(canonicalToolName) || tools.allowList.includes(toolName);
	return { canonicalToolName, observed: allowed };
}
