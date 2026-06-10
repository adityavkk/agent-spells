import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_RECAP_CONFIG,
	getGlobalRecapConfigPath,
	getProjectRecapConfigPath,
	isRecapAutoEnabled,
	loadRecapConfig,
	mergeRecapConfig,
	normalizeRecapConfig,
} from "./config";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("recap config defaults", () => {
	it("matches the documented defaults", () => {
		expect(DEFAULT_RECAP_CONFIG.enabled).toBe(true);
		expect(DEFAULT_RECAP_CONFIG.idleThresholdMs).toBe(180_000);
		expect(DEFAULT_RECAP_CONFIG.minTurns).toBe(3);
		expect(DEFAULT_RECAP_CONFIG.neverTwiceInARow).toBe(true);
		expect(DEFAULT_RECAP_CONFIG.suppressWhileComposing).toBe(true);
		expect(DEFAULT_RECAP_CONFIG.trigger).toBe("focus-idle");
		expect(DEFAULT_RECAP_CONFIG.useFocusReporting).toBe(true);
		expect(DEFAULT_RECAP_CONFIG.summarizeMode).toBe("delta");
		expect(DEFAULT_RECAP_CONFIG.maxLines).toBe(1);
		expect(DEFAULT_RECAP_CONFIG.style).toBe("line");
		expect(DEFAULT_RECAP_CONFIG.commandName).toBe("recap");
		expect(DEFAULT_RECAP_CONFIG.showContextGauge).toBe(false);
	});
});

describe("normalizeRecapConfig", () => {
	it("drops invalid values instead of letting them poison the merge", () => {
		const normalized = normalizeRecapConfig({
			enabled: "yes",
			idleThresholdMs: -5,
			minTurns: "three",
			trigger: "every-5-minutes",
			summarizeMode: "DELTA",
			style: 7,
			commandName: "   ",
			maxLines: Number.NaN,
		});
		expect(normalized.enabled).toBeUndefined();
		expect(normalized.idleThresholdMs).toBeUndefined();
		expect(normalized.minTurns).toBeUndefined();
		expect(normalized.trigger).toBeUndefined();
		expect(normalized.summarizeMode).toBeUndefined();
		expect(normalized.style).toBeUndefined();
		expect(normalized.commandName).toBeUndefined();
		expect(normalized.maxLines).toBeUndefined();
	});

	it("accepts valid values", () => {
		const normalized = normalizeRecapConfig({
			enabled: false,
			idleThresholdMs: 60_000,
			minTurns: 2,
			trigger: "idle-timer",
			summarizeMode: "full",
			style: "panel",
			commandName: "away",
			prompt: "Custom instructions",
			modelSelection: { role: "recap", roleCandidates: ["recap", "smol"] },
		});
		expect(normalized.enabled).toBe(false);
		expect(normalized.idleThresholdMs).toBe(60_000);
		expect(normalized.minTurns).toBe(2);
		expect(normalized.trigger).toBe("idle-timer");
		expect(normalized.summarizeMode).toBe("full");
		expect(normalized.style).toBe("panel");
		expect(normalized.commandName).toBe("away");
		expect(normalized.prompt).toBe("Custom instructions");
		expect(normalized.modelSelection?.role).toBe("recap");
		expect(normalized.modelSelection?.roleCandidates).toEqual(["recap", "smol"]);
	});

	it("normalizes model selection targets", () => {
		const normalized = normalizeRecapConfig({
			modelSelection: {
				targets: [
					{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" },
					{ provider: "", model: "incomplete" },
					"garbage",
				],
			},
		});
		expect(normalized.modelSelection?.targets).toEqual([
			{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001", thinkingLevel: undefined },
		]);
	});

	it("returns an empty partial for non-object input", () => {
		expect(normalizeRecapConfig(null)).toEqual({});
		expect(normalizeRecapConfig([1, 2])).toEqual({});
	});
});

describe("mergeRecapConfig", () => {
	it("overlays only defined values and clamps integers", () => {
		const merged = mergeRecapConfig(DEFAULT_RECAP_CONFIG, {
			idleThresholdMs: 60_000,
			minTurns: 0.4,
			maxLines: 2.9,
		});
		expect(merged.idleThresholdMs).toBe(60_000);
		expect(merged.minTurns).toBe(1); // clamped to >= 1
		expect(merged.maxLines).toBe(2); // floored
		expect(merged.trigger).toBe("focus-idle"); // untouched default
	});
});

describe("loadRecapConfig", () => {
	it("merges defaults <- global <- project, project winning", () => {
		const agentDir = tempDir("recap-agent-");
		const cwd = tempDir("recap-project-");
		writeFileSync(getGlobalRecapConfigPath(agentDir), JSON.stringify({ idleThresholdMs: 60_000, minTurns: 5 }));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(getProjectRecapConfigPath(cwd), JSON.stringify({ minTurns: 2 }));

		const loaded = loadRecapConfig(cwd, agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.mergedConfig.idleThresholdMs).toBe(60_000); // global
		expect(loaded.mergedConfig.minTurns).toBe(2); // project beats global
		expect(loaded.mergedConfig.trigger).toBe("focus-idle"); // default survives
	});

	it("captures parse errors and falls back to defaults", () => {
		const agentDir = tempDir("recap-agent-");
		const cwd = tempDir("recap-project-");
		writeFileSync(getGlobalRecapConfigPath(agentDir), "{not json");

		const loaded = loadRecapConfig(cwd, agentDir);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]!.path).toBe(getGlobalRecapConfigPath(agentDir));
		expect(loaded.mergedConfig).toEqual(DEFAULT_RECAP_CONFIG);
	});

	it("returns pure defaults when no config files exist", () => {
		const loaded = loadRecapConfig(tempDir("recap-project-"), tempDir("recap-agent-"));
		expect(loaded.errors).toEqual([]);
		expect(loaded.mergedConfig).toEqual(DEFAULT_RECAP_CONFIG);
	});
});

describe("isRecapAutoEnabled", () => {
	it("follows the config switch", () => {
		expect(isRecapAutoEnabled({ config: DEFAULT_RECAP_CONFIG, env: {} })).toBe(true);
		expect(
			isRecapAutoEnabled({ config: { ...DEFAULT_RECAP_CONFIG, enabled: false }, env: {} }),
		).toBe(false);
	});

	it("is disabled by PI_RECAP_ENABLED=0", () => {
		expect(isRecapAutoEnabled({ config: DEFAULT_RECAP_CONFIG, env: { PI_RECAP_ENABLED: "0" } })).toBe(false);
		expect(isRecapAutoEnabled({ config: DEFAULT_RECAP_CONFIG, env: { PI_RECAP_ENABLED: "1" } })).toBe(true);
	});

	it("is disabled by the --no-recap flag", () => {
		expect(isRecapAutoEnabled({ config: DEFAULT_RECAP_CONFIG, env: {}, disableFlag: true })).toBe(false);
		expect(isRecapAutoEnabled({ config: DEFAULT_RECAP_CONFIG, env: {}, disableFlag: false })).toBe(true);
		expect(isRecapAutoEnabled({ config: DEFAULT_RECAP_CONFIG, env: {}, disableFlag: undefined })).toBe(true);
	});
});
