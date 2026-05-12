import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoadedProviderToolProfilesConfig, ProviderProfileToggleConfig, ProviderToolProfileName, ProviderToolProfilesConfig } from "./types";

export const PROVIDER_TOOL_PROFILES_FILENAME = "provider-tool-profiles.json";

export const DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG: ProviderToolProfilesConfig = {
	enabled: true,
	profiles: {
		claude: true,
		codex: true,
		gemini: true,
	},
	fallbackTools: ["read", "bash", "edit", "write"],
	modelMatchers: {
		claude: ["anthropic", "claude"],
		codex: ["openai-codex", "codex", "gpt-"],
		gemini: ["google", "gemini"],
	},
};

type ProviderToolProfilesConfigPatch =
	& Partial<Pick<ProviderToolProfilesConfig, "enabled" | "fallbackTools">>
	& {
		profiles?: Partial<ProviderProfileToggleConfig>;
		modelMatchers?: Partial<Record<ProviderToolProfileName, string[]>>;
	};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result.length > 0 ? result : fallback;
}

export function normalizeProviderToolProfilesConfig(input: unknown): ProviderToolProfilesConfig {
	return mergeProviderToolProfilesConfig(DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG, normalizeProviderToolProfilesConfigPatch(input));
}

function normalizeProviderToolProfilesConfigPatch(input: unknown): ProviderToolProfilesConfigPatch {
	if (!isRecord(input)) return {};
	const defaults = DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG;
	const profiles = isRecord(input.profiles) ? input.profiles : {};
	const modelMatchers = isRecord(input.modelMatchers) ? input.modelMatchers : {};
	const patch: ProviderToolProfilesConfigPatch = {};

	if ("enabled" in input) patch.enabled = normalizeBoolean(input.enabled, defaults.enabled);
	if ("fallbackTools" in input) patch.fallbackTools = normalizeStringArray(input.fallbackTools, defaults.fallbackTools);
	for (const profile of ["claude", "codex", "gemini"] as const) {
		if (profile in profiles) {
			patch.profiles = { ...(patch.profiles ?? {}), [profile]: normalizeBoolean(profiles[profile], defaults.profiles[profile]) };
		}
		if (profile in modelMatchers) {
			patch.modelMatchers = {
				...(patch.modelMatchers ?? {}),
				[profile]: normalizeStringArray(modelMatchers[profile], defaults.modelMatchers[profile] ?? []),
			};
		}
	}
	return patch;
}

export function mergeProviderToolProfilesConfig(
	base: ProviderToolProfilesConfig,
	override: ProviderToolProfilesConfigPatch,
): ProviderToolProfilesConfig {
	return {
		enabled: override.enabled ?? base.enabled,
		profiles: {
			claude: override.profiles?.claude ?? base.profiles.claude,
			codex: override.profiles?.codex ?? base.profiles.codex,
			gemini: override.profiles?.gemini ?? base.profiles.gemini,
		},
		fallbackTools: override.fallbackTools?.length ? override.fallbackTools : base.fallbackTools,
		modelMatchers: {
			claude: override.modelMatchers?.claude ?? base.modelMatchers.claude ?? [],
			codex: override.modelMatchers?.codex ?? base.modelMatchers.codex ?? [],
			gemini: override.modelMatchers?.gemini ?? base.modelMatchers.gemini ?? [],
		},
	};
}

export function getGlobalProviderToolProfilesPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, PROVIDER_TOOL_PROFILES_FILENAME);
}

export function getProjectProviderToolProfilesPath(cwd: string): string {
	return join(cwd, ".pi", PROVIDER_TOOL_PROFILES_FILENAME);
}

function readConfigFile(path: string, errors: Array<{ path: string; message: string }>): ProviderToolProfilesConfig {
	if (!existsSync(path)) return DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG;
	try {
		return normalizeProviderToolProfilesConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		errors.push({ path, message: error instanceof Error ? error.message : String(error) });
		return DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG;
	}
}

function readOptionalConfigFile(path: string, errors: Array<{ path: string; message: string }>): ProviderToolProfilesConfigPatch {
	if (!existsSync(path)) return {};
	try {
		return normalizeProviderToolProfilesConfigPatch(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		errors.push({ path, message: error instanceof Error ? error.message : String(error) });
		return {};
	}
}

export function loadProviderToolProfilesConfig(cwd: string, agentDir?: string): LoadedProviderToolProfilesConfig {
	const errors: Array<{ path: string; message: string }> = [];
	const globalPath = getGlobalProviderToolProfilesPath(agentDir);
	const projectPath = getProjectProviderToolProfilesPath(cwd);
	const globalConfig = readConfigFile(globalPath, errors);
	const projectConfig = readOptionalConfigFile(projectPath, errors);

	return {
		globalPath,
		projectPath,
		globalConfig,
		projectConfig: mergeProviderToolProfilesConfig(DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG, projectConfig),
		mergedConfig: mergeProviderToolProfilesConfig(globalConfig, projectConfig),
		errors,
	};
}
