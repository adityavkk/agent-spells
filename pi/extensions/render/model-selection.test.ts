import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { resolveModelRole } from "../model-profiles/resolve";
import type { ModelRegistryLike } from "../model-profiles/types";
import { buildRenderTestProfilesConfig, DEFAULT_RENDER_E2E_PROFILE, DEFAULT_RENDER_E2E_ROLE } from "./model-selection";

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

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config: buildRenderTestProfilesConfig(false),
			profile: { value: DEFAULT_RENDER_E2E_PROFILE, source: "config" },
			role: { value: DEFAULT_RENDER_E2E_ROLE, source: "config" },
		});

		expect(resolved?.profile).toBe(DEFAULT_RENDER_E2E_PROFILE);
		expect(resolved?.role).toBe(DEFAULT_RENDER_E2E_ROLE);
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

		const resolved = await resolveModelRole({
			modelRegistry: registry,
			config: buildRenderTestProfilesConfig(false),
			role: { value: DEFAULT_RENDER_E2E_ROLE, source: "config" },
		});

		expect(resolved?.role).toBe(DEFAULT_RENDER_E2E_ROLE);
		expect(resolved?.matchedRole).toBe("workhorse");
		expect(resolved?.model.provider).toBe("openai-codex");
		expect(resolved?.model.id).toBe("gpt-5.4");
	});
});
