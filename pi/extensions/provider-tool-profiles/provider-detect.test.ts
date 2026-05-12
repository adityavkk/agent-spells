import { describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import { DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG } from "./config";
import { resolveProviderToolProfile } from "./provider-detect";

function model(provider: string, id: string, api = "openai-responses"): Model<any> {
	return { provider, id, name: id, api } as Model<any>;
}

describe("resolveProviderToolProfile", () => {
	it("detects Claude, Codex, and Gemini families", () => {
		expect(resolveProviderToolProfile({
			model: model("anthropic", "claude-sonnet-4-5", "anthropic-messages"),
			env: {},
		})).toBe("claude");
		expect(resolveProviderToolProfile({
			model: model("openai-codex", "gpt-5.4"),
			env: {},
		})).toBe("codex");
		expect(resolveProviderToolProfile({
			model: model("google", "gemini-2.5-pro", "google-generative-ai"),
			env: {},
		})).toBe("gemini");
	});

	it("can disable globally, per profile, or by env override", () => {
		expect(resolveProviderToolProfile({
			model: model("anthropic", "claude-opus"),
			config: { ...DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG, enabled: false },
			env: {},
		})).toBeUndefined();
		expect(resolveProviderToolProfile({
			model: model("anthropic", "claude-opus"),
			config: {
				...DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
				profiles: { ...DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG.profiles, claude: false },
			},
			env: {},
		})).toBeUndefined();
		expect(resolveProviderToolProfile({
			model: model("anthropic", "claude-opus"),
			env: { PI_PROVIDER_TOOL_PROFILE: "off" },
		})).toBeUndefined();
	});

	it("honors a forced profile env override", () => {
		expect(resolveProviderToolProfile({
			model: model("anthropic", "claude-opus"),
			env: { PI_PROVIDER_TOOL_PROFILE: "gemini" },
		})).toBe("gemini");
	});
});

