import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import type { ModelProfilesConfig, ModelRegistryLike } from "../model-profiles/types";
import {
	buildRenderTestProfilesConfig,
	DEFAULT_RENDER_E2E_PROFILE,
	DEFAULT_RENDER_E2E_ROLE,
	getRenderRoleCandidates,
	resolveRenderExtractionModel,
} from "./model-selection";

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

describe("render model selection", () => {
	it("resolves render small role through model-profiles", async () => {
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4-mini"),
			makeModel("openai-codex", "gpt-5.4"),
			makeModel("openai", "gpt-5.4"),
		], [
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.4",
			"openai/gpt-5.4",
		]);

		const resolved = await resolveRenderExtractionModel({
			modelRegistry: registry,
			config: buildRenderTestProfilesConfig(false),
			state: { activeProfile: DEFAULT_RENDER_E2E_PROFILE },
		});

		expect(resolved?.profile).toBe(DEFAULT_RENDER_E2E_PROFILE);
		expect(resolved?.role).toBe("render");
		expect(resolved?.matchedRole).toBe(DEFAULT_RENDER_E2E_ROLE);
		expect(resolved?.model.provider).toBe("openai-codex");
		expect(resolved?.model.id).toBe("gpt-5.4-mini");
		expect(resolved?.thinkingLevel).toBe("minimal");
	});

	it("falls back from render small to workhorse when small target lacks auth", async () => {
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4-mini"),
			makeModel("openai-codex", "gpt-5.4"),
			makeModel("openai", "gpt-5.4"),
		], [
			"openai-codex/gpt-5.4",
			"openai/gpt-5.4",
		]);

		const resolved = await resolveRenderExtractionModel({
			modelRegistry: registry,
			config: buildRenderTestProfilesConfig(false),
		});

		expect(resolved?.role).toBe(DEFAULT_RENDER_E2E_ROLE);
		expect(resolved?.matchedRole).toBe("workhorse");
		expect(resolved?.model.provider).toBe("openai-codex");
		expect(resolved?.model.id).toBe("gpt-5.4");
	});

	it("prefers the active profile and its hidden render role before generic role names", async () => {
		const config: ModelProfilesConfig = {
			activeProfile: "personal",
			profiles: {
				personal: {
					defaultRole: "workhorse",
					roles: {
						render: { fallback: ["smol"] },
						smol: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "minimal" },
						workhorse: { provider: "openai-codex", model: "gpt-5.4" },
					},
				},
				work: {
					defaultRole: "workhorse",
					roles: {
						render: { fallback: ["small"] },
						small: { provider: "openai", model: "gpt-4.1-mini" },
						workhorse: { provider: "openai-codex", model: "gpt-5.4" },
					},
				},
			},
		};
		const registry = makeRegistry([
			makeModel("openai-codex", "gpt-5.4-mini"),
			makeModel("openai-codex", "gpt-5.4"),
			makeModel("openai", "gpt-4.1-mini"),
		], [
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.4",
			"openai/gpt-4.1-mini",
		]);

		const renderConfig = {
			modelSelection: {
				rolesByProfile: {
					personal: "smol",
					work: "small",
				},
				roleCandidates: ["render"],
				fallbackToActiveRole: false,
				fallbackToDefaultRole: false,
			},
		};

		const personal = await resolveRenderExtractionModel({
			modelRegistry: registry,
			config,
			renderConfig,
			state: { activeProfile: "personal", activeRole: "workhorse" },
		});
		const work = await resolveRenderExtractionModel({
			modelRegistry: registry,
			config,
			renderConfig,
			state: { activeProfile: "work", activeRole: "workhorse" },
		});

		expect(personal?.profile).toBe("personal");
		expect(personal?.role).toBe("smol");
		expect(personal?.matchedRole).toBe("smol");
		expect(personal?.model.id).toBe("gpt-5.4-mini");
		expect(work?.profile).toBe("work");
		expect(work?.role).toBe("small");
		expect(work?.matchedRole).toBe("small");
		expect(work?.model.id).toBe("gpt-4.1-mini");
	});

	it("builds configurable per-profile render role candidates", () => {
		const config: ModelProfilesConfig = {
			activeProfile: "personal",
			profiles: {
				personal: {
					defaultRole: "workhorse",
					roles: {
						render: { fallback: ["smol"] },
						smol: { provider: "openai-codex", model: "gpt-5.4-mini" },
						workhorse: { provider: "openai-codex", model: "gpt-5.4" },
					},
				},
			},
		};

		expect(getRenderRoleCandidates(config, { activeProfile: "personal", activeRole: "workhorse" }, {
			modelSelection: {
				rolesByProfile: { personal: "smol" },
				roleCandidates: ["render"],
			},
		})).toEqual(["smol", "render", "workhorse"]);
	});
});
