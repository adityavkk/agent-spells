import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import type { ModelProfilesConfig, ModelRegistryLike } from "../model-profiles/types";
import { DEFAULT_RECAP_CONFIG } from "./config";
import {
	DEFAULT_RECAP_ROLE_CANDIDATES,
	getRecapRoleCandidates,
	resolveRecapModel,
} from "./model-selection";

function makeModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		baseUrl: "https://example.com",
		reasoning: false,
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

/** Mirrors the shape of the author's active "work" profile: smol -> wibey haiku. */
function workLikeProfilesConfig(): ModelProfilesConfig {
	return {
		activeProfile: "work",
		profiles: {
			work: {
				defaultRole: "smart",
				roles: {
					smol: {
						targets: [
							{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" },
							{ provider: "puppy-openai", model: "gpt-5.4-mini", thinkingLevel: "minimal" },
						],
					},
					smart: {
						targets: [{ provider: "puppy-openai", model: "gpt-5.5", thinkingLevel: "high" }],
					},
				},
			},
		},
	};
}

const WIBEY_HAIKU = makeModel("wibey-anthropic", "claude-haiku-4-5-20251001");
const PUPPY_MINI = makeModel("puppy-openai", "gpt-5.4-mini");
const PUPPY_BIG = makeModel("puppy-openai", "gpt-5.5");

describe("recap role candidates", () => {
	it("defaults to recap -> smol -> small", () => {
		expect([...DEFAULT_RECAP_ROLE_CANDIDATES]).toEqual(["recap", "smol", "small"]);
	});

	it("walks candidates then profile fallbacks", () => {
		const candidates = getRecapRoleCandidates(workLikeProfilesConfig(), {}, DEFAULT_RECAP_CONFIG);
		expect(candidates).toEqual(["recap", "smol", "small", "smart"]);
	});

	it("honors an explicit role override from recap.json", () => {
		const candidates = getRecapRoleCandidates(workLikeProfilesConfig(), {}, {
			...DEFAULT_RECAP_CONFIG,
			modelSelection: { role: "writer" },
		});
		expect(candidates[0]).toBe("writer");
	});
});

describe("resolveRecapModel", () => {
	it("resolves wibey haiku through the smol role when no recap role exists", async () => {
		const registry = makeRegistry(
			[WIBEY_HAIKU, PUPPY_MINI, PUPPY_BIG],
			["wibey-anthropic/claude-haiku-4-5-20251001", "puppy-openai/gpt-5.4-mini", "puppy-openai/gpt-5.5"],
		);
		const resolved = await resolveRecapModel({
			modelRegistry: registry,
			config: workLikeProfilesConfig(),
			recapConfig: DEFAULT_RECAP_CONFIG,
		});
		expect(resolved?.matchedRole).toBe("smol");
		expect(resolved?.model.provider).toBe("wibey-anthropic");
		expect(resolved?.model.id).toBe("claude-haiku-4-5-20251001");
	});

	it("prefers a dedicated recap role when configured", async () => {
		const config = workLikeProfilesConfig();
		config.profiles.work!.roles.recap = {
			targets: [{ provider: "puppy-openai", model: "gpt-5.4-mini", thinkingLevel: "minimal" }],
		};
		const registry = makeRegistry(
			[WIBEY_HAIKU, PUPPY_MINI],
			["wibey-anthropic/claude-haiku-4-5-20251001", "puppy-openai/gpt-5.4-mini"],
		);
		const resolved = await resolveRecapModel({
			modelRegistry: registry,
			config,
			recapConfig: DEFAULT_RECAP_CONFIG,
		});
		expect(resolved?.matchedRole).toBe("recap");
		expect(resolved?.model.id).toBe("gpt-5.4-mini");
	});

	it("falls through smol targets when the first lacks auth", async () => {
		const registry = makeRegistry([WIBEY_HAIKU, PUPPY_MINI], ["puppy-openai/gpt-5.4-mini"]);
		const resolved = await resolveRecapModel({
			modelRegistry: registry,
			config: workLikeProfilesConfig(),
			recapConfig: DEFAULT_RECAP_CONFIG,
		});
		expect(resolved?.model.id).toBe("gpt-5.4-mini");
	});

	it("honors direct targets from recap.json over role resolution", async () => {
		const registry = makeRegistry(
			[WIBEY_HAIKU, PUPPY_MINI],
			["wibey-anthropic/claude-haiku-4-5-20251001", "puppy-openai/gpt-5.4-mini"],
		);
		const resolved = await resolveRecapModel({
			modelRegistry: registry,
			config: workLikeProfilesConfig(),
			recapConfig: {
				...DEFAULT_RECAP_CONFIG,
				modelSelection: {
					targets: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }],
				},
			},
		});
		expect(resolved?.source).toBe("config");
		expect(resolved?.model.id).toBe("claude-haiku-4-5-20251001");
	});
});
