import { describe, expect, it } from "bun:test";
import { DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG } from "./config";
import { CLAUDE_TOOLS, CODEX_TOOLS } from "./profiles";
import { resolveActiveTools } from "./tool-activation";

describe("resolveActiveTools", () => {
	it("swaps managed core tools and preserves unrelated extension tools", () => {
		const resolved = resolveActiveTools({
			activeTools: ["read", "bash", "render", "answer"],
			profile: "claude",
			config: DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
		});

		expect(resolved.tools).toEqual([...CLAUDE_TOOLS, "render", "answer"]);
		expect(resolved.state.previousCoreTools).toEqual(["read", "bash"]);
	});

	it("switches profiles without duplicating managed tools", () => {
		const first = resolveActiveTools({
			activeTools: ["read", "bash", "render"],
			profile: "claude",
			config: DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
		});
		const second = resolveActiveTools({
			activeTools: first.tools,
			profile: "codex",
			config: DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
			state: first.state,
		});

		expect(second.tools).toEqual([...CODEX_TOOLS, "render"]);
		expect(second.state.previousCoreTools).toEqual(["read", "bash"]);
	});

	it("restores previous core tools when no provider profile applies", () => {
		const first = resolveActiveTools({
			activeTools: ["read", "bash", "edit", "write", "render"],
			profile: "claude",
			config: DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
		});
		const restored = resolveActiveTools({
			activeTools: first.tools,
			config: DEFAULT_PROVIDER_TOOL_PROFILES_CONFIG,
			state: first.state,
		});

		expect(restored.tools).toEqual(["read", "bash", "edit", "write", "render"]);
		expect(restored.state.lastProfile).toBeUndefined();
	});
});

