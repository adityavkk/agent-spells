import type { ModelLike, ProviderToolProfile, ProviderToolProfilesConfig } from "./types";

function includesAny(value: string, needles: readonly string[] | undefined): boolean {
	if (!needles) return false;
	return needles.some((needle) => value.includes(needle));
}

function field(model: ModelLike | undefined, key: "provider" | "id" | "api"): string {
	return String(model?.[key] ?? "").toLowerCase();
}

function matchesConfiguredProfile(model: ModelLike | undefined, config: ProviderToolProfilesConfig, profile: ProviderToolProfile): boolean {
	const matcher = config.matchers[profile];
	return includesAny(field(model, "provider"), matcher.providerIncludes)
		|| includesAny(field(model, "id"), matcher.idIncludes)
		|| includesAny(field(model, "api"), matcher.apiIncludes);
}

export function detectProviderToolProfile(
	model: ModelLike | undefined,
	config: ProviderToolProfilesConfig,
	env: Record<string, string | undefined> = process.env,
): ProviderToolProfile | undefined {
	if (!config.enabled) return undefined;
	const forced = env.PI_PROVIDER_TOOL_PROFILE?.trim().toLowerCase();
	if (forced === "off") return undefined;
	if (forced === "claude" || forced === "codex" || forced === "gemini") {
		return config.profiles[forced] ? forced : undefined;
	}

	if (!model) return undefined;
	if (config.profiles.claude && matchesConfiguredProfile(model, config, "claude")) return "claude";
	if (config.profiles.gemini && matchesConfiguredProfile(model, config, "gemini")) return "gemini";

	const provider = field(model, "provider");
	const id = field(model, "id");
	const api = field(model, "api");
	const configuredCodex = config.profiles.codex && matchesConfiguredProfile(model, config, "codex");
	const openAiGpt = config.profiles.codex && provider.includes("openai") && id.startsWith("gpt-");
	const openAiApi = config.profiles.codex && api.includes("openai") && id.startsWith("gpt-");
	return configuredCodex || openAiGpt || openAiApi ? "codex" : undefined;
}
