import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { buildSyntheticProfileModelId, buildSyntheticProfileProviderModels, isSyntheticProfileModel, parseSyntheticProfileModelId, rotateResolvedRoleCandidates } from "./provider";
import type { ModelProfilesConfig, ModelRegistryLike, ResolvedRoleResult } from "./types";

function makeModel(provider: string, id: string, overrides: Partial<Model<any>> = {}): Model<any> {
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
		...overrides,
	} as Model<any>;
}

function makeRegistry(models: Array<Model<any>>): ModelRegistryLike {
	const byRef = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
	return {
		find(provider, modelId) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return models;
		},
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test-key" };
		},
	};
}

describe("synthetic profile model ids", () => {
	it("builds and parses profile role ids", () => {
		const id = buildSyntheticProfileModelId("personal", "smart");
		expect(id).toBe("personal:smart");
		expect(parseSyntheticProfileModelId(id)).toEqual({ profile: "personal", role: "smart" });
		expect(parseSyntheticProfileModelId("missing-separator")).toBeNull();
		expect(isSyntheticProfileModel({ provider: "profiles", id })).toBeTrue();
		expect(isSyntheticProfileModel({ provider: "openai", id })).toBeFalse();
	});
});

describe("rotateResolvedRoleCandidates", () => {
	it("starts from the sticky cursor and wraps around", () => {
		const first = makeModel("a", "one");
		const second = makeModel("b", "two");
		const third = makeModel("c", "three");
		const resolved: ResolvedRoleResult = {
			model: first,
			ref: { provider: "a", model: "one" },
			profile: "personal",
			role: "smart",
			source: "config",
			trace: [],
			candidates: [
				{ model: first, ref: { provider: "a", model: "one" } },
				{ model: second, ref: { provider: "b", model: "two" } },
				{ model: third, ref: { provider: "c", model: "three" } },
			],
		};

		expect(rotateResolvedRoleCandidates(resolved, 1).candidates.map((candidate) => candidate.ref.model)).toEqual(["two", "three", "one"]);
	});
});

describe("buildSyntheticProfileProviderModels", () => {
	it("registers roles before a model registry is available", () => {
		const config: ModelProfilesConfig = {
			profiles: {
				work: {
					defaultRole: "smart",
					roles: {
						smart: {
							targets: [
								{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
							],
						},
					},
				},
			},
		};

		const models = buildSyntheticProfileProviderModels(config);
		expect(models.map((model) => model.id)).toEqual(["work:smart"]);
		expect(models[0]?.reasoning).toBeTrue();
		expect(models[0]?.input).toEqual(["text"]);
		expect(models[0]?.contextWindow).toBe(128_000);
		expect(models[0]?.maxTokens).toBe(16_384);
	});

	it("registers roles using concrete targets across fallback chains", () => {
		const registry = makeRegistry([
			makeModel("code-puppy", "gpt-5.4", { reasoning: true, input: ["text", "image"], contextWindow: 150_000, maxTokens: 10_000 }),
			makeModel("wibey-anthropic", "claude-opus-4-6", { reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8_000 }),
		]);
		const config: ModelProfilesConfig = {
			profiles: {
				personal: {
					defaultRole: "workhorse",
					roles: {
						smol: {
							fallback: ["workhorse"],
						},
						workhorse: {
							targets: [
								{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
								{ provider: "wibey-anthropic", model: "claude-opus-4-6" },
							],
						},
					},
				},
			},
		};

		const models = buildSyntheticProfileProviderModels(config, registry);
		expect(models.map((model) => model.id)).toEqual(["personal:smol", "personal:workhorse"]);
		expect(models[0]?.reasoning).toBeTrue();
		expect(models[0]?.input).toEqual(["text"]);
		expect(models[0]?.contextWindow).toBe(150_000);
		expect(models[0]?.maxTokens).toBe(8_000);
	});
});
