import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { buildSyntheticProfileModelId } from "./provider";
import { formatModelProfilesStateSummary, formatModelProfilesStatus, getAppliedThinkingLevel, isRawOverride } from "./state";
import { MODEL_PROFILES_PROVIDER, type ResolvedRoleResult } from "./types";

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
		expect(isRawOverride(resolved, makeModel("openai", "gpt-4.1"))).toBeTrue();
		expect(isRawOverride(resolved, makeModel("openai-codex", "gpt-5.4-mini"))).toBeFalse();
		expect(isRawOverride(resolved, makeModel(MODEL_PROFILES_PROVIDER, buildSyntheticProfileModelId("work", "small")))).toBeFalse();
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

describe("formatModelProfilesStateSummary", () => {
	it("includes status, current model, and resolved model summary", () => {
		expect(formatModelProfilesStateSummary({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai-codex", "gpt-5.4-mini"),
		})).toContain("work:small");
	});
});
