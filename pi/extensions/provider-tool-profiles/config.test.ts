import { describe, expect, it } from "bun:test";
import { DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG, mergeProviderToolProfilesConfig, normalizeProviderToolProfilesConfig } from "./config";

describe("provider tool profile config", () => {
	it("normalizes partial config without resetting unspecified nested values", () => {
		const base = {
			...DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
			profiles: { claude: true, codex: false, gemini: true },
		};
		const patch = normalizeProviderToolProfilesConfig({
			fallbackTools: ["read"],
		});

		expect(mergeProviderToolProfilesConfig(base, { fallbackTools: patch.fallbackTools })).toEqual({
			...base,
			fallbackTools: ["read"],
		});
	});

	it("keeps explicit profile toggles", () => {
		expect(normalizeProviderToolProfilesConfig({
			profiles: { gemini: false },
		}).profiles).toEqual({
			claude: true,
			codex: true,
			gemini: false,
		});
	});
});

