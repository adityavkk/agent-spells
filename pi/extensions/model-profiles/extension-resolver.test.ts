import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { getExtensionRoleCandidates, resolveExtensionExtractionModel } from "./extension-resolver";
import type { ModelProfilesConfig, ModelRegistryLike } from "./types";

function makeModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as Model<any>;
}

function makeRegistry(models: Array<Model<any>>, authenticatedRefs: string[]): ModelRegistryLike {
	const byRef = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
	const authSet = new Set(authenticatedRefs);
	return {
		find(provider, modelId) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return models.filter((model) => authSet.has(`${model.provider}/${model.id}`));
		},
		async getApiKeyAndHeaders(model) {
			if (authSet.has(`${model.provider}/${model.id}`)) {
				return { ok: true, apiKey: "test-key" };
			}
			return { ok: false, error: "missing auth" };
		},
	};
}

const realisticConfig: ModelProfilesConfig = {
	activeProfile: "work",
	profiles: {
		work: {
			defaultRole: "smart",
			roles: {
				smol: { targets: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }] },
				workhorse: { targets: [{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" }] },
				smart: { targets: [{ provider: "wibey-anthropic", model: "claude-opus-4-7", thinkingLevel: "high" }] },
			},
		},
		personal: {
			defaultRole: "smart",
			roles: {
				small: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "minimal" },
				smol: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "minimal" },
				smart: { provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
			},
		},
	},
};

describe("resolveExtensionExtractionModel", () => {
	it("does not bleed into the active profile's defaultRole when the requested role is missing", async () => {
		// Reproduces the original bug: answer extension with role candidate \"small\"
		// against the \"work\" profile (which only has smol/workhorse/smart) used to
		// silently fall through to defaultRole \"smart\" -> claude-opus-4-7.
		const registry = makeRegistry([
			makeModel("wibey-anthropic", "claude-haiku-4-5-20251001"),
			makeModel("wibey-anthropic", "claude-opus-4-7"),
			makeModel("code-puppy", "gpt-5.4"),
		], [
			"wibey-anthropic/claude-haiku-4-5-20251001",
			"wibey-anthropic/claude-opus-4-7",
			"code-puppy/gpt-5.4",
		]);

		const resolved = await resolveExtensionExtractionModel({
			modelRegistry: registry,
			config: realisticConfig,
			defaultRoleCandidates: ["small", "smol"],
		});

		// Should iterate ["small","smol"] -> small missing -> smol matches haiku.
		expect(resolved?.profile).toBe("work");
		expect(resolved?.role).toBe("smol");
		expect(resolved?.matchedRole).toBe("smol");
		expect(resolved?.model.provider).toBe("wibey-anthropic");
		expect(resolved?.model.id).toBe("claude-haiku-4-5-20251001");
	});

	it("respects state.activeProfile from session entries", async () => {
		const registry = makeRegistry([
			makeModel("wibey-anthropic", "claude-haiku-4-5-20251001"),
			makeModel("openai-codex", "gpt-5.4-mini"),
		], [
			"wibey-anthropic/claude-haiku-4-5-20251001",
			"openai-codex/gpt-5.4-mini",
		]);

		const personal = await resolveExtensionExtractionModel({
			modelRegistry: registry,
			config: realisticConfig,
			state: { activeProfile: "personal" },
			defaultRoleCandidates: ["small", "smol"],
		});

		expect(personal?.profile).toBe("personal");
		expect(personal?.role).toBe("small");
		expect(personal?.model.provider).toBe("openai-codex");
		expect(personal?.model.id).toBe("gpt-5.4-mini");
	});

	it("honors selection.role to pin a specific role", async () => {
		const registry = makeRegistry([
			makeModel("wibey-anthropic", "claude-haiku-4-5-20251001"),
			makeModel("code-puppy", "gpt-5.4"),
		], [
			"wibey-anthropic/claude-haiku-4-5-20251001",
			"code-puppy/gpt-5.4",
		]);

		const resolved = await resolveExtensionExtractionModel({
			modelRegistry: registry,
			config: realisticConfig,
			selection: { role: "workhorse" },
			defaultRoleCandidates: ["small", "smol"],
		});

		expect(resolved?.role).toBe("workhorse");
		expect(resolved?.model.provider).toBe("code-puppy");
		expect(resolved?.model.id).toBe("gpt-5.4");
	});

	it("honors selection.targets ahead of role resolution", async () => {
		const registry = makeRegistry([
			makeModel("wibey-anthropic", "claude-haiku-4-5-20251001"),
			makeModel("openai-codex", "gpt-5.4-mini"),
		], [
			"wibey-anthropic/claude-haiku-4-5-20251001",
			"openai-codex/gpt-5.4-mini",
		]);

		const resolved = await resolveExtensionExtractionModel({
			modelRegistry: registry,
			config: realisticConfig,
			selection: {
				targets: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
			},
			defaultRoleCandidates: ["small", "smol"],
		});

		expect(resolved?.model.provider).toBe("openai-codex");
		expect(resolved?.model.id).toBe("gpt-5.4-mini");
		expect(resolved?.role).toBeUndefined();
	});

	it("honors per-profile selection.targetsByProfile", async () => {
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4-mini"),
			makeModel("wibey-anthropic", "claude-haiku-4-5-20251001"),
		], [
			"openai-codex/gpt-5.4-mini",
			"wibey-anthropic/claude-haiku-4-5-20251001",
		]);

		const resolved = await resolveExtensionExtractionModel({
			modelRegistry: registry,
			config: realisticConfig,
			state: { activeProfile: "work" },
			selection: {
				targetsByProfile: {
					work: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }],
					personal: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
				},
			},
			defaultRoleCandidates: ["small", "smol"],
		});

		expect(resolved?.profile).toBe("work");
		expect(resolved?.model.provider).toBe("wibey-anthropic");
		expect(resolved?.model.id).toBe("claude-haiku-4-5-20251001");
	});
});

describe("getExtensionRoleCandidates", () => {
	it("composes per-profile + explicit + defaults + active + default-role", () => {
		expect(getExtensionRoleCandidates(
			realisticConfig,
			{ activeProfile: "work", activeRole: "writer" },
			{
				rolesByProfile: { work: "smol" },
				roleCandidates: ["small"],
			},
			["smol"],
		)).toEqual(["smol", "small", "writer", "smart"]);
	});

	it("can disable defaultRole and active role injection", () => {
		expect(getExtensionRoleCandidates(
			realisticConfig,
			{ activeProfile: "work", activeRole: "writer" },
			{
				roleCandidates: ["small", "smol"],
				fallbackToActiveRole: false,
				fallbackToDefaultRole: false,
			},
			[],
		)).toEqual(["small", "smol"]);
	});
});
