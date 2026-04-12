import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	MODEL_PROFILES_FILENAME,
	type LoadedModelProfilesConfig,
	type ModelProfileConfig,
	type ModelProfilesConfig,
	type ModelProfilesConfigError,
	type ModelProfilesState,
	type ModelProfilesThinkingLevel,
	type ModelRoleConfig,
} from "./types";

const THINKING_LEVELS = new Set<ModelProfilesThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeThinkingLevel(value: unknown): ModelProfilesThinkingLevel | undefined {
	const normalized = normalizeString(value)?.toLowerCase() as ModelProfilesThinkingLevel | undefined;
	return normalized && THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function normalizeFallback(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const fallback: string[] = [];
	for (const item of value) {
		const normalized = normalizeString(item);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		fallback.push(normalized);
	}
	return fallback.length > 0 ? fallback : undefined;
}

function normalizeRoleConfig(value: unknown): ModelRoleConfig | undefined {
	if (!isRecord(value)) return undefined;
	return {
		provider: normalizeString(value.provider),
		model: normalizeString(value.model),
		thinkingLevel: normalizeThinkingLevel(value.thinkingLevel),
		fallback: normalizeFallback(value.fallback),
	};
}

function normalizeRoles(value: unknown): Record<string, ModelRoleConfig> {
	if (!isRecord(value)) return {};
	const roles: Record<string, ModelRoleConfig> = {};
	for (const [rawName, rawRole] of Object.entries(value)) {
		const name = normalizeString(rawName);
		const role = normalizeRoleConfig(rawRole);
		if (!name || !role) continue;
		roles[name] = role;
	}
	return roles;
}

function normalizeProfileConfig(value: unknown): ModelProfileConfig | undefined {
	if (!isRecord(value)) return undefined;
	return {
		defaultRole: normalizeString(value.defaultRole),
		roles: normalizeRoles(value.roles),
	};
}

function normalizeProfiles(value: unknown): Record<string, ModelProfileConfig> {
	if (!isRecord(value)) return {};
	const profiles: Record<string, ModelProfileConfig> = {};
	for (const [rawName, rawProfile] of Object.entries(value)) {
		const name = normalizeString(rawName);
		const profile = normalizeProfileConfig(rawProfile);
		if (!name || !profile) continue;
		profiles[name] = profile;
	}
	return profiles;
}

export function normalizeModelProfilesState(input: unknown): ModelProfilesState {
	if (!isRecord(input)) return {};
	return {
		activeProfile: normalizeString(input.activeProfile),
		activeRole: normalizeString(input.activeRole),
	};
}

export function normalizeModelProfilesConfig(input: unknown): ModelProfilesConfig {
	if (!isRecord(input)) {
		return { profiles: {} };
	}

	return {
		activeProfile: normalizeString(input.activeProfile),
		profiles: normalizeProfiles(input.profiles),
	};
}

function mergeRoleConfig(base?: ModelRoleConfig, override?: ModelRoleConfig): ModelRoleConfig {
	return {
		provider: override?.provider ?? base?.provider,
		model: override?.model ?? base?.model,
		thinkingLevel: override?.thinkingLevel ?? base?.thinkingLevel,
		fallback: override?.fallback ?? base?.fallback,
	};
}

function mergeProfileConfig(base?: ModelProfileConfig, override?: ModelProfileConfig): ModelProfileConfig {
	const roles: Record<string, ModelRoleConfig> = {};
	for (const roleName of new Set([
		...Object.keys(base?.roles ?? {}),
		...Object.keys(override?.roles ?? {}),
	])) {
		roles[roleName] = mergeRoleConfig(base?.roles[roleName], override?.roles[roleName]);
	}

	return {
		defaultRole: override?.defaultRole ?? base?.defaultRole,
		roles,
	};
}

export function mergeModelProfilesConfig(base: ModelProfilesConfig, override: ModelProfilesConfig): ModelProfilesConfig {
	const profiles: Record<string, ModelProfileConfig> = {};
	for (const profileName of new Set([...Object.keys(base.profiles), ...Object.keys(override.profiles)])) {
		profiles[profileName] = mergeProfileConfig(base.profiles[profileName], override.profiles[profileName]);
	}

	return {
		activeProfile: override.activeProfile ?? base.activeProfile,
		profiles,
	};
}

export function getGlobalModelProfilesPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, MODEL_PROFILES_FILENAME);
}

export function getProjectModelProfilesPath(cwd: string): string {
	return join(cwd, ".pi", MODEL_PROFILES_FILENAME);
}

function readConfigFile(path: string, errors: ModelProfilesConfigError[]): ModelProfilesConfig {
	if (!existsSync(path)) return { profiles: {} };

	try {
		return normalizeModelProfilesConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		errors.push({
			path,
			message: error instanceof Error ? error.message : String(error),
		});
		return { profiles: {} };
	}
}

export function loadModelProfilesConfig(cwd: string, agentDir?: string): LoadedModelProfilesConfig {
	const errors: ModelProfilesConfigError[] = [];
	const globalPath = getGlobalModelProfilesPath(agentDir);
	const projectPath = getProjectModelProfilesPath(cwd);
	const globalConfig = readConfigFile(globalPath, errors);
	const projectConfig = readConfigFile(projectPath, errors);
	const mergedConfig = mergeModelProfilesConfig(globalConfig, projectConfig);

	return {
		globalPath,
		projectPath,
		globalConfig,
		projectConfig,
		mergedConfig,
		errors,
	};
}
