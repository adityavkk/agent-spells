import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { formatModelProfilesStateSummary, formatModelProfilesStatus, isRawOverride } from "./state";
import type { ResolvedRoleResult } from "./types";

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
};

describe("isRawOverride", () => {
	it("detects when current model drifts from resolved role target", () => {
		expect(isRawOverride(resolved, makeModel("openai", "gpt-4.1"))).toBeTrue();
		expect(isRawOverride(resolved, makeModel("openai-codex", "gpt-5.4-mini"))).toBeFalse();
	});
});

describe("formatModelProfilesStatus", () => {
	it("formats active profile + role status", () => {
		expect(formatModelProfilesStatus({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai-codex", "gpt-5.4-mini"),
		})).toBe("profile:work role:small");
	});

	it("appends raw-override and unresolved suffixes", () => {
		expect(formatModelProfilesStatus({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai", "gpt-4.1"),
		})).toBe("profile:work role:small raw-override");

		expect(formatModelProfilesStatus({
			state: { activeProfile: "work", activeRole: "small" },
			unresolved: true,
		})).toBe("profile:work role:small unresolved");
	});
});

describe("formatModelProfilesStateSummary", () => {
	it("includes status, current model, and resolved model summary", () => {
		expect(formatModelProfilesStateSummary({
			state: { activeProfile: "work", activeRole: "small" },
			resolved,
			currentModel: makeModel("openai-codex", "gpt-5.4-mini"),
		})).toContain("profile:work role:small");
	});
});
