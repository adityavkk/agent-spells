import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { readModelProfilesState, resolveModelRole } from "./resolve";
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

const config: ModelProfilesConfig = {
	activeProfile: "work",
	profiles: {
		work: {
			defaultRole: "workhorse",
			roles: {
				small: {
					provider: "openai-codex",
					model: "gpt-5.4-mini",
					thinkingLevel: "minimal",
					fallback: ["workhorse"],
				},
				workhorse: {
					provider: "openai-codex",
					model: "gpt-5.4",
					thinkingLevel: "medium",
				},
				smart: {
					provider: "anthropic",
					model: "claude-opus-4-1",
					thinkingLevel: "high",
				},
			},
		},
		personal: {
			defaultRole: "small",
			roles: {
				small: {
					provider: "ollama",
					model: "gemma4:e4b",
					thinkingLevel: "low",
				},
			},
		},
	},
};

describe("readModelProfilesState", () => {
	it("returns the latest model-profiles custom entry", () => {
		expect(readModelProfilesState([
			{ type: "custom", customType: "other", data: { activeProfile: "nope" } },
			{ type: "custom", customType: "model-profiles-state", data: { activeProfile: "work", activeRole: "small" } },
			{ type: "custom", customType: "model-profiles-state", data: { activeProfile: "personal", activeRole: "small" } },
		])).toEqual({
			activeProfile: "personal",
			activeRole: "small",
		});
	});
});

describe("resolveModelRole", () => {
	it("prefers explicit profile + role over env, session, and config", async () => {
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4-mini"),
			makeModel("openai-codex", "gpt-5.4"),
			makeModel("anthropic", "claude-opus-4-1"),
			makeModel("ollama", "gemma4:e4b"),
		], [
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.4",
			"anthropic/claude-opus-4-1",
			"ollama/gemma4:e4b",
		]);

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config,
			state: { activeProfile: "personal", activeRole: "small" },
			env: { PI_MODEL_PROFILE: "personal", PI_MODEL_ROLE: "small" },
			profile: { value: "work", source: "flag" },
			role: { value: "smart", source: "flag" },
		});

		expect(resolved?.model.provider).toBe("anthropic");
		expect(resolved?.model.id).toBe("claude-opus-4-1");
		expect(resolved?.profile).toBe("work");
		expect(resolved?.role).toBe("smart");
		expect(resolved?.matchedRole).toBe("smart");
		expect(resolved?.source).toBe("flag");
		expect(resolved?.candidates.map((candidate) => candidate.matchedRole)).toEqual(["smart", "workhorse"]);
	});

	it("uses role fallback chain before dropping to current model", async () => {
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4-mini"),
			makeModel("openai-codex", "gpt-5.4"),
			makeModel("anthropic", "claude-opus-4-1"),
		], [
			"openai-codex/gpt-5.4",
		]);

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config,
			role: { value: "small", source: "flag" },
		});

		expect(resolved?.model.id).toBe("gpt-5.4");
		expect(resolved?.role).toBe("small");
		expect(resolved?.matchedRole).toBe("workhorse");
		expect(resolved?.thinkingLevel).toBe("medium");
		expect(resolved?.trace.some((line) => line.includes("auth unavailable"))).toBeTrue();
		expect(resolved?.candidates.map((candidate) => candidate.ref.model)).toEqual(["gpt-5.4"]);
	});

	it("uses profile default role when no role is requested", async () => {
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4"),
		], [
			"openai-codex/gpt-5.4",
		]);

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config,
		});

		expect(resolved?.model.id).toBe("gpt-5.4");
		expect(resolved?.role).toBe("workhorse");
		expect(resolved?.matchedRole).toBe("workhorse");
	});

	it("falls back to current model when configured role cannot resolve", async () => {
		const currentModel = makeModel("openai", "gpt-4.1");
		const registry = makeRegistry([
			currentModel,
		], [
			"openai/gpt-4.1",
		]);

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config,
			profile: { value: "missing", source: "flag" },
			role: { value: "small", source: "flag" },
			currentModel,
		});

		expect(resolved?.model.id).toBe("gpt-4.1");
		expect(resolved?.source).toBe("current-model");
	});

	it("can disable fallback to current or first available models", async () => {
		const currentModel = makeModel("openai", "gpt-4.1");
		const registry = makeRegistry([
			currentModel,
		], [
			"openai/gpt-4.1",
		]);

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config,
			profile: { value: "missing", source: "flag" },
			role: { value: "small", source: "flag" },
			currentModel,
			allowModelFallbacks: false,
		});

		expect(resolved).toBeNull();
	});

	it("falls back to first available model when current model also lacks auth", async () => {
		const currentModel = makeModel("openai", "gpt-4.1");
		const firstAvailable = makeModel("anthropic", "claude-sonnet-4-5");
		const registry = makeRegistry([
			currentModel,
			firstAvailable,
		], [
			"anthropic/claude-sonnet-4-5",
		]);

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config,
			profile: { value: "missing", source: "flag" },
			role: { value: "small", source: "flag" },
			currentModel,
		});

		expect(resolved?.model.provider).toBe("anthropic");
		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
		expect(resolved?.source).toBe("first-available");
	});

	it("keeps ordered concrete targets inside one role", async () => {
		const registry = makeRegistry([
			makeModel("code-puppy", "gpt-5.4"),
			makeModel("wibey-anthropic", "claude-opus-4-6"),
		], [
			"code-puppy/gpt-5.4",
			"wibey-anthropic/claude-opus-4-6",
		]);
		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config: {
				activeProfile: "work",
				profiles: {
					work: {
						defaultRole: "smart",
						roles: {
							smart: {
								targets: [
									{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
									{ provider: "wibey-anthropic", model: "claude-opus-4-6" },
								],
							},
						},
					},
				},
			},
		});

		expect(resolved?.model.provider).toBe("code-puppy");
		expect(resolved?.model.id).toBe("gpt-5.4");
		expect(resolved?.candidates.map((candidate) => `${candidate.ref.provider}/${candidate.ref.model}`)).toEqual([
			"code-puppy/gpt-5.4",
			"wibey-anthropic/claude-opus-4-6",
		]);
	});
});
