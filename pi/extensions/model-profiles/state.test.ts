import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { buildSyntheticProfileModelId } from "./provider";
import {
	formatModelProfilesStateSummary,
	formatModelProfilesStatus,
	getAppliedThinkingLevel,
	getEffectiveModelProfilesThinkingLevel,
	isRawOverride,
	readModelProfilesRuntimeState,
} from "./state";
import { MODEL_PROFILES_PROVIDER, MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE, type ResolvedRoleResult } from "./types";

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

const resolved: ResolvedRoleResult = {
	model: makeModel("openai-codex", "gpt-5.4-mini"),
	ref: {
		provider: "openai-codex",
		model: "gpt-5.4-mini",
		thinkingLevel: "minimal",
	},
	thinkingLevel: "minimal",
	profile: "work",
	role: "small",
	matchedRole: "small",
	source: "config",
	trace: [],
	candidates: [{
		model: makeModel("openai-codex", "gpt-5.4-mini"),
		ref: {
			provider: "openai-codex",
			model: "gpt-5.4-mini",
			thinkingLevel: "minimal",
		},
		matchedRole: "small",
	}],
};

describe("isRawOverride", () => {
	it("detects when current model drifts from resolved role target", () => {
		expect(isRawOverride({ resolved, currentModel: makeModel("openai", "gpt-4.1") })).toBeTrue();
		expect(isRawOverride({ resolved, currentModel: makeModel("openai-codex", "gpt-5.4-mini") })).toBeFalse();
		expect(isRawOverride({ resolved, currentModel: makeModel(MODEL_PROFILES_PROVIDER, buildSyntheticProfileModelId("work", "small")) })).toBeFalse();
	});

	it("treats alias roles with identical policy as non-overrides", () => {
		const config = {
			profiles: {
				personal: {
					defaultRole: "workhorse",
					roles: {
						small: {
							provider: "openai-codex",
							model: "gpt-5.4-mini",
							thinkingLevel: "minimal",
							fallback: ["workhorse"],
						},
						smol: {
							provider: "openai-codex",
							model: "gpt-5.4-mini",
							thinkingLevel: "minimal",
							fallback: ["workhorse"],
						},
						workhorse: {
							provider: "openai-codex",
							model: "gpt-5.4",
						},
					},
				},
			},
		};
		const aliasResolved = {
			...resolved,
			profile: "personal",
			role: "smol",
			matchedRole: "smol",
		};
		expect(isRawOverride({
			config,
			resolved: aliasResolved,
			currentModel: makeModel(MODEL_PROFILES_PROVIDER, buildSyntheticProfileModelId("personal", "small")),
		})).toBeFalse();
	});
});

describe("formatModelProfilesStatus", () => {
	it("formats active profile + role status", () => {
		expect(formatModelProfilesStatus({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai-codex", "gpt-5.4-mini"),
		})).toBe("work:small");
	});

	it("appends raw-override and unresolved suffixes", () => {
		expect(formatModelProfilesStatus({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai", "gpt-4.1"),
		})).toBe("work:small raw-override");

		expect(formatModelProfilesStatus({
			state: { activeProfile: "work", activeRole: "small" },
			unresolved: true,
		})).toBe("work:small unresolved");
	});
});

describe("readModelProfilesRuntimeState", () => {
	it("keeps per-selection thinking overrides", () => {
		expect(readModelProfilesRuntimeState([{
			type: "custom",
			customType: MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE,
			data: {
				selections: {
					"work:smart": {
						thinkingOverride: "low",
						lastWinner: { provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
					},
				},
			},
		}]).selections["work:smart"]?.thinkingOverride).toBe("low");
	});
});

describe("getAppliedThinkingLevel", () => {
	it("defaults missing thinking level to off", () => {
		expect(getAppliedThinkingLevel(resolved)).toBe("minimal");
		expect(getAppliedThinkingLevel({
			...resolved,
			thinkingLevel: undefined,
			ref: {
				provider: resolved.ref.provider,
				model: resolved.ref.model,
			},
		})).toBe("off");
	});
});

describe("getEffectiveModelProfilesThinkingLevel", () => {
	it("prefers explicit overrides over runtime winner and resolved defaults", () => {
		expect(getEffectiveModelProfilesThinkingLevel({
			profile: "work",
			role: "small",
			resolved,
			runtimeSelection: {
				thinkingOverride: "low",
				lastWinner: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			},
		})).toBe("low");
	});

	it("uses the runtime winner thinking level, defaulting missing thinking to off", () => {
		expect(getEffectiveModelProfilesThinkingLevel({
			profile: "work",
			role: "small",
			resolved,
			runtimeSelection: {
				lastWinner: { provider: "wibey-anthropic", model: "claude-sonnet-4-5" },
			},
		})).toBe("off");
	});

	it("falls back to the resolved role thinking level", () => {
		expect(getEffectiveModelProfilesThinkingLevel({
			profile: "work",
			role: "small",
			resolved,
		})).toBe("minimal");
	});
});

describe("formatModelProfilesStateSummary", () => {
	it("includes status, current model, and resolved model summary", () => {
		expect(formatModelProfilesStateSummary({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai-codex", "gpt-5.4-mini"),
		})).toContain("work:small");
	});
});
