import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	PI_CORE_TOOLS,
	PROVIDER_TOOL_PROFILES_FILENAME,
	type LoadedProviderToolProfilesConfig,
	type PartialProviderToolProfilesConfig,
	type ProfileMatcherConfig,
	type ProviderToolProfile,
	type ProviderToolProfilesConfig,
} from "./types";

const PROFILE_NAMES: ProviderToolProfile[] = ["claude", "codex", "gemini"];

const DEFAULT_CONFIG: ProviderToolProfilesConfig = {
	enabled: true,
	preserveExtensionTools: true,
	fallbackTools: PI_CORE_TOOLS.slice(0, 4),
	profiles: { claude: true, codex: true, gemini: true },
	matchers: {
		claude: {
			providerIncludes: ["anthropic"],
			idIncludes: ["claude"],
			apiIncludes: ["anthropic"],
		},
		codex: {
			providerIncludes: ["openai-codex"],
			idIncludes: ["codex"],
			apiIncludes: ["openai"],
		},
		gemini: {
			providerIncludes: ["google", "gemini"],
			idIncludes: ["gemini"],
			apiIncludes: ["google", "gemini"],
		},
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const text = item.trim().toLowerCase();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		normalized.push(text);
	}
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const names: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const name = item.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names.length > 0 ? names : undefined;
}

function normalizeMatcher(value: unknown): ProfileMatcherConfig | undefined {
	if (!isRecord(value)) return undefined;
	return {
		providerIncludes: normalizeStringArray(value.providerIncludes),
		idIncludes: normalizeStringArray(value.idIncludes),
		apiIncludes: normalizeStringArray(value.apiIncludes),
	};
}

export function normalizeProviderToolProfilesConfig(input: unknown): PartialProviderToolProfilesConfig {
	if (!isRecord(input)) return {};
	const profiles: Partial<Record<ProviderToolProfile, boolean>> = {};
	if (isRecord(input.profiles)) {
		for (const profile of PROFILE_NAMES) {
			if (typeof input.profiles[profile] === "boolean") profiles[profile] = input.profiles[profile];
		}
	}

	const matchers: Partial<Record<ProviderToolProfile, ProfileMatcherConfig>> = {};
	if (isRecord(input.matchers)) {
		for (const profile of PROFILE_NAMES) {
			const matcher = normalizeMatcher(input.matchers[profile]);
			if (matcher) matchers[profile] = matcher;
		}
	}

	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
		preserveExtensionTools: typeof input.preserveExtensionTools === "boolean" ? input.preserveExtensionTools : undefined,
		fallbackTools: normalizeToolNames(input.fallbackTools),
		profiles: Object.keys(profiles).length > 0 ? profiles : undefined,
		matchers: Object.keys(matchers).length > 0 ? matchers : undefined,
	};
}

export function mergeProviderToolProfilesConfig(
	base: PartialProviderToolProfilesConfig,
	override: PartialProviderToolProfilesConfig,
): ProviderToolProfilesConfig {
	const merged: ProviderToolProfilesConfig = {
		enabled: override.enabled ?? base.enabled ?? DEFAULT_CONFIG.enabled,
		preserveExtensionTools: override.preserveExtensionTools ?? base.preserveExtensionTools ?? DEFAULT_CONFIG.preserveExtensionTools,
		fallbackTools: override.fallbackTools ?? base.fallbackTools ?? DEFAULT_CONFIG.fallbackTools,
		profiles: { ...DEFAULT_CONFIG.profiles, ...base.profiles, ...override.profiles },
		matchers: { ...DEFAULT_CONFIG.matchers },
	};
	for (const profile of PROFILE_NAMES) {
		merged.matchers[profile] = {
			...DEFAULT_CONFIG.matchers[profile],
			...base.matchers?.[profile],
			...override.matchers?.[profile],
		};
	}
	return applyEnvOverrides(merged);
}

function applyEnvOverrides(config: ProviderToolProfilesConfig): ProviderToolProfilesConfig {
	const enabled = process.env.PI_PROVIDER_TOOL_PROFILES;
	const forcedProfile = process.env.PI_PROVIDER_TOOL_PROFILE?.trim().toLowerCase();
	const next: ProviderToolProfilesConfig = {
		...config,
		profiles: { ...config.profiles },
		matchers: { ...config.matchers },
	};
	if (enabled === "0" || enabled?.toLowerCase() === "false") next.enabled = false;
	if (forcedProfile === "off") next.enabled = false;
	if (forcedProfile && ["claude", "codex", "gemini"].includes(forcedProfile)) {
		for (const profile of PROFILE_NAMES) next.profiles[profile] = profile === forcedProfile;
	}
	return next;
}

export function getGlobalProviderToolProfilesPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, PROVIDER_TOOL_PROFILES_FILENAME);
}

export function getProjectProviderToolProfilesPath(cwd: string): string {
	return join(cwd, ".pi", PROVIDER_TOOL_PROFILES_FILENAME);
}

function readConfigFile(path: string, errors: Array<{ path: string; message: string }>): PartialProviderToolProfilesConfig {
	if (!existsSync(path)) return {};
	try {
		return normalizeProviderToolProfilesConfig(JSON.parse(readFileSync(path, "utf-8")));
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
	const projectConfig = readConfigFile(projectPath, errors);
	return {
		globalPath,
		projectPath,
		globalConfig,
		projectConfig,
		mergedConfig: mergeProviderToolProfilesConfig(globalConfig, projectConfig),
		errors,
	};
}
