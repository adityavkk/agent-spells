/**
 * recap.json loader: global (~/.pi/agent/recap.json) merged with project
 * (<cwd>/.pi/recap.json), project values winning. Mirrors render/config.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRoleConfigTarget } from "../model-profiles/types";
import type {
	RecapConfig,
	RecapModelSelectionConfig,
	RecapStyle,
	RecapSummarizeMode,
	RecapTriggerMode,
} from "./types";

export const RECAP_CONFIG_FILENAME = "recap.json";

/** recap.json shape before defaults are applied. */
export type RecapConfigInput = Partial<RecapConfig>;

export interface RecapConfigError {
	path: string;
	message: string;
}

export interface LoadedRecapConfig {
	globalPath: string;
	projectPath: string;
	mergedConfig: RecapConfig;
	errors: RecapConfigError[];
}

export const DEFAULT_RECAP_CONFIG: RecapConfig = {
	enabled: true,
	idleThresholdMs: 180_000,
	minTurns: 3,
	neverTwiceInARow: true,
	suppressWhileComposing: true,
	trigger: "focus-idle",
	useFocusReporting: true,
	modelSelection: {},
	maxInputTokens: 12_000,
	summarizeMode: "delta",
	maxLines: 1,
	style: "line",
	commandName: "recap",
	prompt: undefined,
	showContextGauge: false,
	generationTimeoutMs: 30_000,
	focusDebounceMs: 250,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	const normalized = normalizeString(value);
	return allowed.includes(normalized as T) ? (normalized as T) : undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		const normalizedKey = normalizeString(key);
		const normalizedValue = normalizeString(rawValue);
		if (!normalizedKey || !normalizedValue) continue;
		normalized[normalizedKey] = normalizedValue;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of value) {
		const entry = normalizeString(item);
		if (!entry || seen.has(entry)) continue;
		seen.add(entry);
		normalized.push(entry);
	}
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeRoleTarget(value: unknown): ModelRoleConfigTarget | undefined {
	if (!isRecord(value)) return undefined;
	const provider = normalizeString(value.provider);
	const model = normalizeString(value.model);
	const thinkingLevel = normalizeString(value.thinkingLevel) as ModelRoleConfigTarget["thinkingLevel"] | undefined;
	if (!provider && !model && !thinkingLevel) return undefined;
	return { provider, model, thinkingLevel };
}

function normalizeRoleTargets(value: unknown): ModelRoleConfigTarget[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const targets = value
		.map(normalizeRoleTarget)
		.filter((item): item is ModelRoleConfigTarget => !!item && !!item.provider && !!item.model);
	return targets.length > 0 ? targets : undefined;
}

function normalizeTargetsByProfile(value: unknown): Record<string, ModelRoleConfigTarget[]> | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: Record<string, ModelRoleConfigTarget[]> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		const normalizedKey = normalizeString(key);
		const normalizedValue = normalizeRoleTargets(rawValue);
		if (!normalizedKey || !normalizedValue) continue;
		normalized[normalizedKey] = normalizedValue;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeModelSelectionConfig(value: unknown): RecapModelSelectionConfig | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: RecapModelSelectionConfig = {
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
	return normalized;
}

/** Normalize raw JSON into a partial config; unknown/invalid values are dropped. */
export function normalizeRecapConfig(value: unknown): RecapConfigInput {
	if (!isRecord(value)) return {};
	return {
		enabled: normalizeBoolean(value.enabled),
		idleThresholdMs: normalizePositiveNumber(value.idleThresholdMs),
		minTurns: normalizePositiveNumber(value.minTurns),
		neverTwiceInARow: normalizeBoolean(value.neverTwiceInARow),
		suppressWhileComposing: normalizeBoolean(value.suppressWhileComposing),
		trigger: normalizeEnum<RecapTriggerMode>(value.trigger, ["focus-idle", "idle-timer"]),
		useFocusReporting: normalizeBoolean(value.useFocusReporting),
		modelSelection: normalizeModelSelectionConfig(value.modelSelection),
		maxInputTokens: normalizePositiveNumber(value.maxInputTokens),
		summarizeMode: normalizeEnum<RecapSummarizeMode>(value.summarizeMode, ["delta", "full"]),
		maxLines: normalizePositiveNumber(value.maxLines),
		style: normalizeEnum<RecapStyle>(value.style, ["line", "panel"]),
		commandName: normalizeString(value.commandName),
		prompt: normalizeString(value.prompt),
		showContextGauge: normalizeBoolean(value.showContextGauge),
		generationTimeoutMs: normalizePositiveNumber(value.generationTimeoutMs),
		focusDebounceMs: normalizePositiveNumber(value.focusDebounceMs),
	};
}

/** Overlay defined values from `override` onto `base`. */
export function mergeRecapConfig(base: RecapConfig, override: RecapConfigInput): RecapConfig {
	const merged: RecapConfig = { ...base };
	for (const key of Object.keys(override) as Array<keyof RecapConfigInput>) {
		const value = override[key];
		if (value === undefined) continue;
		// Safe: RecapConfigInput is Partial<RecapConfig>, so types align per key.
		(merged as unknown as Record<string, unknown>)[key] = value;
	}
	merged.minTurns = Math.max(1, Math.floor(merged.minTurns));
	merged.maxLines = Math.max(1, Math.floor(merged.maxLines));
	// A zero/near-zero timeout would disable the abort timer and wedge the
	// in-flight guard forever on a hung provider; enforce a sane floor.
	merged.generationTimeoutMs = Math.max(1_000, merged.generationTimeoutMs);
	return merged;
}

export function getGlobalRecapConfigPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, RECAP_CONFIG_FILENAME);
}

export function getProjectRecapConfigPath(cwd: string): string {
	return join(cwd, ".pi", RECAP_CONFIG_FILENAME);
}

function readConfigFile(path: string, errors: RecapConfigError[]): RecapConfigInput {
	if (!existsSync(path)) return {};
	try {
		return normalizeRecapConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		errors.push({
			path,
			message: error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}

export function loadRecapConfig(cwd: string, agentDir?: string): LoadedRecapConfig {
	const errors: RecapConfigError[] = [];
	const globalPath = getGlobalRecapConfigPath(agentDir);
	const projectPath = getProjectRecapConfigPath(cwd);
	const globalConfig = readConfigFile(globalPath, errors);
	const projectConfig = readConfigFile(projectPath, errors);
	return {
		globalPath,
		projectPath,
		mergedConfig: mergeRecapConfig(mergeRecapConfig(DEFAULT_RECAP_CONFIG, globalConfig), projectConfig),
		errors,
	};
}

/**
 * Whether the automatic recap is active, after config, env, and CLI flag.
 * The /recap command stays available even when this is false.
 */
export function isRecapAutoEnabled(input: {
	config: RecapConfig;
	env?: Record<string, string | undefined>;
	disableFlag?: boolean | string | undefined;
}): boolean {
	const env = input.env ?? process.env;
	if (env.PI_RECAP_ENABLED === "0") return false;
	if (input.disableFlag === true) return false;
	return input.config.enabled;
}
