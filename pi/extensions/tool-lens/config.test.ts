import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyToolLensEnvOverrides,
	DEFAULT_TOOL_LENS_CONFIG,
	loadToolLensConfig,
	mergeToolLensConfig,
	resolveToolObservation,
} from "./config";

describe("mergeToolLensConfig", () => {
	it("returns the base config for non-object input", () => {
		expect(mergeToolLensConfig(DEFAULT_TOOL_LENS_CONFIG, null)).toEqual(DEFAULT_TOOL_LENS_CONFIG);
		expect(mergeToolLensConfig(DEFAULT_TOOL_LENS_CONFIG, 42)).toEqual(DEFAULT_TOOL_LENS_CONFIG);
	});

	it("overrides scalars and merges aliases", () => {
		const merged = mergeToolLensConfig(DEFAULT_TOOL_LENS_CONFIG, {
			mode: "intent-only",
			analysis: { maxConcurrentAnalyses: 5 },
			tools: { aliases: { my_tool: "bash" }, blockList: ["write"] },
			rendering: { defaultVisibility: "compact" },
		});
		expect(merged.mode).toBe("intent-only");
		expect(merged.analysis.maxConcurrentAnalyses).toBe(5);
		expect(merged.tools.aliases.my_tool).toBe("bash");
		// Built-in aliases are preserved when merging a new one in.
		expect(merged.tools.aliases.shell_command).toBe("bash");
		expect(merged.tools.blockList).toEqual(["write"]);
		expect(merged.rendering.defaultVisibility).toBe("compact");
	});

	it("ignores invalid-typed fields and keeps defaults", () => {
		const merged = mergeToolLensConfig(DEFAULT_TOOL_LENS_CONFIG, {
			enabled: "yes",
			mode: "nonsense",
			analysis: { timeoutMs: -5 },
			rendering: { defaultVisibility: "loud" },
		});
		expect(merged.enabled).toBe(true);
		expect(merged.mode).toBe("intent-and-outcome");
		expect(merged.analysis.timeoutMs).toBe(DEFAULT_TOOL_LENS_CONFIG.analysis.timeoutMs);
		expect(merged.rendering.defaultVisibility).toBe("full");
	});

	it("normalizes model selection targets", () => {
		const merged = mergeToolLensConfig(DEFAULT_TOOL_LENS_CONFIG, {
			modelSelection: {
				roleCandidates: ["tool-lens", "smol", "tool-lens"],
				targets: [{ provider: "openai", model: "gpt-5.4-mini" }, { provider: "", model: "x" }],
			},
		});
		expect(merged.modelSelection.roleCandidates).toEqual(["tool-lens", "smol"]);
		expect(merged.modelSelection.targets).toEqual([{ provider: "openai", model: "gpt-5.4-mini", thinkingLevel: undefined }]);
	});
});

describe("applyToolLensEnvOverrides", () => {
	it("disables via PI_TOOL_LENS and toggles surfaces", () => {
		const result = applyToolLensEnvOverrides(DEFAULT_TOOL_LENS_CONFIG, {
			PI_TOOL_LENS: "0",
			PI_TOOL_LENS_HUD: "0",
			PI_TOOL_LENS_CARDS: "false",
			PI_TOOL_LENS_RENDER: "hidden",
		});
		expect(result.enabled).toBe(false);
		expect(result.rendering.liveHud).toBe(false);
		expect(result.rendering.persistCards).toBe(false);
		expect(result.rendering.defaultVisibility).toBe("hidden");
	});

	it("leaves config untouched when env is empty", () => {
		const result = applyToolLensEnvOverrides(DEFAULT_TOOL_LENS_CONFIG, {});
		expect(result).toEqual(DEFAULT_TOOL_LENS_CONFIG);
	});
});

describe("loadToolLensConfig", () => {
	it("merges global then project, project wins", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "tool-lens-global-"));
		const cwd = mkdtempSync(join(tmpdir(), "tool-lens-project-"));
		writeFileSync(join(agentDir, "tool-lens.json"), JSON.stringify({ mode: "intent-only", analysis: { timeoutMs: 1000 } }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tool-lens.json"), JSON.stringify({ analysis: { timeoutMs: 2000 } }));

		const loaded = loadToolLensConfig(cwd, agentDir, {});
		expect(loaded.errors).toEqual([]);
		expect(loaded.mergedConfig.mode).toBe("intent-only"); // from global
		expect(loaded.mergedConfig.analysis.timeoutMs).toBe(2000); // project wins
	});

	it("records parse errors without throwing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tool-lens-bad-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tool-lens.json"), "{ not json");
		const loaded = loadToolLensConfig(cwd, mkdtempSync(join(tmpdir(), "tool-lens-empty-")), {});
		expect(loaded.errors.length).toBe(1);
		expect(loaded.mergedConfig).toEqual(DEFAULT_TOOL_LENS_CONFIG);
	});
});

describe("resolveToolObservation", () => {
	const tools = DEFAULT_TOOL_LENS_CONFIG.tools;

	it("normalizes aliases to canonical names", () => {
		expect(resolveToolObservation("shell_command", tools)).toEqual({ canonicalToolName: "bash", observed: true });
		expect(resolveToolObservation("apply_patch", tools)).toEqual({ canonicalToolName: "edit", observed: true });
	});

	it("blocklist wins over allowlist", () => {
		const blocked = { ...tools, blockList: ["bash"] };
		expect(resolveToolObservation("shell_command", blocked)).toEqual({ canonicalToolName: "bash", observed: false });
	});

	it("respects a non-wildcard allowlist", () => {
		const restricted = { ...tools, allowList: ["read"] };
		expect(resolveToolObservation("bash", restricted).observed).toBe(false);
		expect(resolveToolObservation("read_file", restricted)).toEqual({ canonicalToolName: "read", observed: true });
	});
});
