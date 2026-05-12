import type { Model } from "@mariozechner/pi-ai";
import { DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG } from "./config";
import type { ProfileResolutionInput, ProviderToolProfileName, ProviderToolProfilesConfig } from "./types";

function haystackForModel(model: Model<any> | undefined): string {
	if (!model) return "";
	return [
		model.provider,
		model.id,
		model.name,
		model.api,
		model.baseUrl,
	].filter(Boolean).join(" ").toLowerCase();
}

function normalizeForcedProfile(value: string | undefined): ProviderToolProfileName | "off" | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off" || normalized === "0" || normalized === "false") return "off";
	if (normalized === "claude" || normalized === "codex" || normalized === "gemini") return normalized;
	return undefined;
}

function matchesProfile(model: Model<any> | undefined, profile: ProviderToolProfileName, config: ProviderToolProfilesConfig): boolean {
	const haystack = haystackForModel(model);
	if (!haystack) return false;
	return (config.modelMatchers[profile] ?? []).some((matcher) => {
		const normalized = matcher.toLowerCase();
		return normalized.endsWith("-")
			? haystack.includes(normalized)
			: haystack.includes(normalized);
	});
}

export function resolveProviderToolProfile(input: ProfileResolutionInput): ProviderToolProfileName | undefined {
	const config = input.config ?? DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG;
	const env = input.env ?? process.env;
	if (!config.enabled || env.PI_PROVIDER_TOOL_PROFILES === "0") return undefined;

	const forced = normalizeForcedProfile(env.PI_PROVIDER_TOOL_PROFILE);
	if (forced === "off") return undefined;
	if (forced && config.profiles[forced]) return forced;

	for (const profile of ["claude", "codex", "gemini"] as const) {
		if (config.profiles[profile] && matchesProfile(input.model, profile, config)) {
			return profile;
		}
	}

	return undefined;
}

