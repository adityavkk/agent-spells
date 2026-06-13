import { describe, expect, it } from "bun:test";
import { mergeProviderToolProfilesConfig } from "./config";
import { applyProfilePromptAppendix, buildProviderToolActivation, getProfilePromptAppendix, toolsForCanonicalCapabilities } from "./tool-activation";

const config = mergeProviderToolProfilesConfig({}, {});

describe("buildProviderToolActivation", () => {
	it("maps only active canonical capabilities and preserves unrelated extension tools", () => {
		const result = buildProviderToolActivation(["read", "bash", "edit", "write", "answer"], "claude", config);
		expect(result.tools).toEqual(["Read", "Bash", "Edit", "MultiEdit", "Write", "answer"]);
		expect(result.profileTools).toEqual(["Read", "Bash", "Edit", "MultiEdit", "Write"]);
		expect(result.state.previousCoreTools).toEqual(["read", "bash", "edit", "write"]);
	});

	it("does not grant shell or mutation tools to Claude read-only roles", () => {
		const result = buildProviderToolActivation(["read", "grep", "find", "ls", "answer"], "claude", config);
		expect(result.tools).toEqual(["Read", "Grep", "Glob", "LS", "answer"]);
		expect(result.tools).not.toContain("Bash");
		expect(result.tools).not.toContain("Edit");
		expect(result.tools).not.toContain("MultiEdit");
		expect(result.tools).not.toContain("Write");
	});

	it("keeps Codex read canonical while mapping search/list to shell without mutation", () => {
		const result = buildProviderToolActivation(["read", "grep", "find", "ls", "answer"], "codex", config);
		expect(result.tools).toEqual(["read", "shell_command", "answer"]);
		expect(result.profileTools).toEqual(["shell_command"]);
		expect(result.tools).not.toContain("apply_patch");
	});

	it("exposes Codex mutation only when edit or write capabilities were active", () => {
		const readOnly = buildProviderToolActivation(["read", "answer"], "codex", config);
		const writeCapable = buildProviderToolActivation(["read", "write", "answer"], "codex", config);
		const editCapable = buildProviderToolActivation(["read", "edit", "answer"], "codex", config);
		expect(readOnly.tools).toEqual(["read", "answer"]);
		expect(writeCapable.tools).toEqual(["read", "apply_patch", "answer"]);
		expect(editCapable.tools).toEqual(["read", "apply_patch", "answer"]);
	});

	it("switches managed tools without dropping preserved tools", () => {
		const first = buildProviderToolActivation(["read", "bash", "answer"], "claude", config);
		const second = buildProviderToolActivation(first.tools, "codex", config, first.state);
		expect(second.tools).toEqual(["read", "shell_command", "answer"]);
		expect(second.profileTools).toEqual(["shell_command"]);
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
		expect(result.tools).toEqual(["Read"]);
	});

	it("uses fallback tools as the canonical source when no core tools are active", () => {
		const result = buildProviderToolActivation(["answer"], "gemini", config);
		expect(result.state.previousCoreTools).toEqual(["read", "bash", "edit", "write"]);
		expect(result.tools).toEqual(["read_file", "read_many_files", "run_shell_command", "replace", "write_file", "answer"]);
	});

	it("maps canonical capabilities through a pure helper", () => {
		expect(toolsForCanonicalCapabilities("gemini", ["read", "grep", "read", "unknown"])).toEqual([
			"read_file",
			"read_many_files",
			"grep_search",
			"search_file_content",
		]);
	});

	it("writes prompt appendices from active profile tools only", () => {
		const appendix = getProfilePromptAppendix("claude", ["Read", "Grep"]);
		expect(appendix).toContain("Read, Grep");
		expect(appendix).not.toContain("Bash");
		expect(appendix).not.toContain("Write");
		expect(getProfilePromptAppendix("codex", [])).toBeUndefined();
	});

	it("replaces stale profile prompt appendices without duplicating them", () => {
		const first = applyProfilePromptAppendix("base", "claude", ["Read", "Grep"]);
		expect(first).toContain("Read, Grep");
		expect(applyProfilePromptAppendix(first!, "claude", ["Read", "Grep"])).toBeUndefined();

		const changed = applyProfilePromptAppendix(first!, "claude", ["Read"]);
		expect(changed).toContain("Active provider tools: Read.");
		expect(changed).not.toContain("Grep");
	});
});
