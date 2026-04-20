import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRenderConfig, mergeRenderConfig, normalizeRenderConfig } from "./config";

describe("render config", () => {
	it("normalizes render model selection config", () => {
		expect(normalizeRenderConfig({
			modelSelection: {
				profile: " personal ",
				role: " smol ",
				rolesByProfile: {
					personal: " smol ",
					work: " small ",
				},
				roleCandidates: [" render ", "smol", "smol", ""],
				useActiveProfile: true,
				fallbackToActiveRole: false,
				fallbackToDefaultRole: true,
			},
		})).toEqual({
			modelSelection: {
				profile: "personal",
				role: "smol",
				rolesByProfile: {
					personal: "smol",
					work: "small",
				},
				roleCandidates: ["render", "smol"],
				useActiveProfile: true,
				fallbackToActiveRole: false,
				fallbackToDefaultRole: true,
			},
		});
	});

	it("merges global and project render config", () => {
		const merged = mergeRenderConfig({
			modelSelection: {
				rolesByProfile: { personal: "smol" },
				roleCandidates: ["render", "smol"],
				useActiveProfile: true,
			},
		}, {
			modelSelection: {
				rolesByProfile: { work: "small" },
				fallbackToDefaultRole: false,
			},
		});

		expect(merged).toEqual({
			modelSelection: {
				rolesByProfile: { personal: "smol", work: "small" },
				roleCandidates: ["render", "smol"],
				useActiveProfile: true,
				fallbackToDefaultRole: false,
			},
		});
	});

	it("loads and merges config files", () => {
		const root = mkdtempSync(join(tmpdir(), "render-config-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "render.json"), JSON.stringify({
			modelSelection: {
				rolesByProfile: { personal: "smol" },
				roleCandidates: ["render", "smol"],
			},
		}));
		writeFileSync(join(cwd, ".pi", "render.json"), JSON.stringify({
			modelSelection: {
				rolesByProfile: { work: "small" },
				fallbackToActiveRole: false,
			},
		}));

		const loaded = loadRenderConfig(cwd, agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.mergedConfig).toEqual({
			modelSelection: {
				rolesByProfile: { personal: "smol", work: "small" },
				roleCandidates: ["render", "smol"],
				fallbackToActiveRole: false,
			},
		});

		rmSync(root, { recursive: true, force: true });
	});
});
