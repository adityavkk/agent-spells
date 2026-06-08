/**
 * Per-extension configuration for the answer extension.
 *
 * Mirrors render/config.ts. Loaded from:
 *   - `~/.pi/agent/answer.json` (global)
 *   - `<cwd>/.pi/answer.json` (project; wins on conflict)
 *
 * Used to override how the answer extension picks a small model for question
 * extraction. Without this file, the extension uses
 * DEFAULT_ANSWER_ROLE_CANDIDATES against the active model-profiles selection.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionModelSelectionConfig } from "../model-profiles/extension-resolver";
import type { ModelRoleConfigTarget } from "../model-profiles/types";

export const ANSWER_CONFIG_FILENAME = "answer.json";

export interface AnswerConfig {
	modelSelection: ExtensionModelSelectionConfig;
}

export interface AnswerConfigError {
	path: string;
	message: string;
}

export interface LoadedAnswerConfig {
	globalPath: string;
	projectPath: string;
	globalConfig: AnswerConfig;
	projectConfig: AnswerConfig;
	mergedConfig: AnswerConfig;
	errors: AnswerConfigError[];
}

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
		const role = normalizeString(item);
		if (!role || seen.has(role)) continue;
		seen.add(role);
		normalized.push(role);
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
		.filter((item) => !!item)
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

function normalizeModelSelectionConfig(value: unknown): ExtensionModelSelectionConfig {
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

export function normalizeAnswerConfig(value: unknown): AnswerConfig {
	if (!isRecord(value)) return { modelSelection: {} };
	return {
		modelSelection: normalizeModelSelectionConfig(value.modelSelection),
	};
}

export function mergeAnswerConfig(base: AnswerConfig, override: AnswerConfig): AnswerConfig {
	return {
		modelSelection: {
			profile: override.modelSelection.profile ?? base.modelSelection.profile,
			role: override.modelSelection.role ?? base.modelSelection.role,
			rolesByProfile: {
				...(base.modelSelection.rolesByProfile ?? {}),
				...(override.modelSelection.rolesByProfile ?? {}),
			},
			roleCandidates: override.modelSelection.roleCandidates ?? base.modelSelection.roleCandidates,
			useActiveProfile: override.modelSelection.useActiveProfile ?? base.modelSelection.useActiveProfile,
			fallbackToActiveRole: override.modelSelection.fallbackToActiveRole ?? base.modelSelection.fallbackToActiveRole,
			fallbackToDefaultRole: override.modelSelection.fallbackToDefaultRole ?? base.modelSelection.fallbackToDefaultRole,
			provider: override.modelSelection.provider ?? base.modelSelection.provider,
			model: override.modelSelection.model ?? base.modelSelection.model,
			thinkingLevel: override.modelSelection.thinkingLevel ?? base.modelSelection.thinkingLevel,
			targets: override.modelSelection.targets ?? base.modelSelection.targets,
			targetsByProfile: {
				...(base.modelSelection.targetsByProfile ?? {}),
				...(override.modelSelection.targetsByProfile ?? {}),
			},
		},
	};
}

export function getGlobalAnswerConfigPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, ANSWER_CONFIG_FILENAME);
}

export function getProjectAnswerConfigPath(cwd: string): string {
	return join(cwd, ".pi", ANSWER_CONFIG_FILENAME);
}

function readConfigFile(path: string, errors: AnswerConfigError[]): AnswerConfig {
	if (!existsSync(path)) return { modelSelection: {} };
	try {
		return normalizeAnswerConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		errors.push({
			path,
			message: error instanceof Error ? error.message : String(error),
		});
		return { modelSelection: {} };
	}
}

export function loadAnswerConfig(cwd: string, agentDir?: string): LoadedAnswerConfig {
	const errors: AnswerConfigError[] = [];
	const globalPath = getGlobalAnswerConfigPath(agentDir);
	const projectPath = getProjectAnswerConfigPath(cwd);
	const globalConfig = readConfigFile(globalPath, errors);
	const projectConfig = readConfigFile(projectPath, errors);
	return {
		globalPath,
		projectPath,
		globalConfig,
		projectConfig,
		mergedConfig: mergeAnswerConfig(globalConfig, projectConfig),
		errors,
	};
}

export const DEFAULT_ANSWER_MODEL_ROLE = "small";
export const DEFAULT_ANSWER_FALLBACK_ROLE = "smol";
export const DEFAULT_ANSWER_ROLE_CANDIDATES = [
	DEFAULT_ANSWER_MODEL_ROLE,
	DEFAULT_ANSWER_FALLBACK_ROLE,
] as const;
