import { describe, expect, it } from "bun:test";
import { mergeProviderToolProfilesConfig } from "./config";
import { detectProviderToolProfile } from "./provider-detect";

const config = mergeProviderToolProfilesConfig({}, {});

describe("detectProviderToolProfile", () => {
	it("detects Claude from Anthropic provider or id", () => {
		expect(detectProviderToolProfile({ provider: "anthropic", id: "claude-sonnet-4" }, config, {})).toBe("claude");
		expect(detectProviderToolProfile({ provider: "proxy", id: "claude-opus" }, config, {})).toBe("claude");
	});

	it("detects Codex for openai-codex, codex ids, and GPT ids", () => {
		expect(detectProviderToolProfile({ provider: "openai-codex", id: "gpt-5.4" }, config, {})).toBe("codex");
		expect(detectProviderToolProfile({ provider: "openai", id: "codex-mini" }, config, {})).toBe("codex");
		expect(detectProviderToolProfile({ provider: "openai", id: "gpt-4.1" }, config, {})).toBe("codex");
	});

	it("detects Gemini from Google provider or Gemini id", () => {
		expect(detectProviderToolProfile({ provider: "google", id: "gemini-2.5-pro" }, config, {})).toBe("gemini");
		expect(detectProviderToolProfile({ provider: "vertex", id: "gemini-2.5-flash" }, config, {})).toBe("gemini");
	});

	it("supports forced env override and off", () => {
		expect(detectProviderToolProfile({ provider: "anthropic", id: "claude" }, config, { PI_PROVIDER_TOOL_PROFILE: "gemini" })).toBe("gemini");
		expect(detectProviderToolProfile({ provider: "anthropic", id: "claude" }, config, { PI_PROVIDER_TOOL_PROFILE: "off" })).toBeUndefined();
	});

	it("returns undefined for unknown models", () => {
		expect(detectProviderToolProfile({ provider: "ollama", id: "llama" }, config, {})).toBeUndefined();
	});
});
