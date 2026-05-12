import { describe, expect, it } from "bun:test";
import { mergeProviderToolProfilesConfig } from "./config";
import { buildProviderToolActivation } from "./tool-activation";
import { CLAUDE_TOOLS, CODEX_TOOLS } from "./types";

const config = mergeProviderToolProfilesConfig({}, {});

describe("buildProviderToolActivation", () => {
	it("activates provider tools and preserves unrelated extension tools", () => {
		const result = buildProviderToolActivation(["read", "bash", "edit", "write", "answer"], "claude", config);
		expect(result.tools).toEqual([...CLAUDE_TOOLS, "answer"]);
		expect(result.state.previousCoreTools).toEqual(["read", "bash", "edit", "write"]);
	});

	it("switches managed tools without dropping preserved tools", () => {
		const first = buildProviderToolActivation(["read", "bash", "answer"], "claude", config);
		const second = buildProviderToolActivation(first.tools, "codex", config, first.state);
		expect(second.tools).toEqual([...CODEX_TOOLS, "answer"]);
		expect(second.state.previousCoreTools).toEqual(["read", "bash"]);
	});

	it("restores prior Pi core tools when no profile applies", () => {
		const first = buildProviderToolActivation(["read", "bash", "custom"], "claude", config);
		const restored = buildProviderToolActivation(first.tools, undefined, config, first.state);
		expect(restored.tools).toEqual(["read", "bash", "custom"]);
	});

	it("can replace active tools when preservation is disabled", () => {
		const noPreserve = mergeProviderToolProfilesConfig({}, { preserveExtensionTools: false });
		const result = buildProviderToolActivation(["read", "custom"], "claude", noPreserve);
		expect(result.tools).toEqual([...CLAUDE_TOOLS]);
	});
});
