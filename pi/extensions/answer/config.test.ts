import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAnswerConfig, mergeAnswerConfig, normalizeAnswerConfig } from "./config";

describe("answer config", () => {
	it("normalizes answer model selection config", () => {
		expect(normalizeAnswerConfig({
			modelSelection: {
				profile: " personal ",
				role: " smol ",
				rolesByProfile: {
					personal: " smol ",
					work: " small ",
				},
				roleCandidates: [" small ", "smol", "smol", ""],
				useActiveProfile: true,
				fallbackToActiveRole: false,
				fallbackToDefaultRole: false,
				provider: " openai-codex ",
				model: " gpt-5.4-mini ",
				thinkingLevel: "minimal",
				targets: [
					{ provider: " code-puppy ", model: " gpt-5.4-mini ", thinkingLevel: "minimal" },
				],
				targetsByProfile: {
					work: [
						{ provider: " wibey-anthropic ", model: " claude-haiku-4-5-20251001 " },
					],
				},
			},
		})).toEqual({
			modelSelection: {
				profile: "personal",
				role: "smol",
				rolesByProfile: {
					personal: "smol",
					work: "small",
				},
				roleCandidates: ["small", "smol"],
				useActiveProfile: true,
				fallbackToActiveRole: false,
				fallbackToDefaultRole: false,
				provider: "openai-codex",
				model: "gpt-5.4-mini",
				thinkingLevel: "minimal",
				targets: [
					{ provider: "code-puppy", model: "gpt-5.4-mini", thinkingLevel: "minimal" },
				],
				targetsByProfile: {
					work: [
						{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" },
					],
				},
			},
		});
	});

	it("merges global and project answer config", () => {
		const merged = mergeAnswerConfig({
			modelSelection: {
				rolesByProfile: { personal: "smol" },
				roleCandidates: ["small", "smol"],
				targetsByProfile: {
					personal: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
				},
			},
		}, {
			modelSelection: {
				rolesByProfile: { work: "smol" },
				fallbackToDefaultRole: false,
				targetsByProfile: {
					work: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }],
				},
			},
		});

		expect(merged).toEqual({
			modelSelection: {
				rolesByProfile: { personal: "smol", work: "smol" },
				roleCandidates: ["small", "smol"],
				fallbackToDefaultRole: false,
				targetsByProfile: {
					personal: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
					work: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }],
				},
			},
		});
	});

	it("loads and merges answer config files", () => {
		const root = mkdtempSync(join(tmpdir(), "answer-config-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "answer.json"), JSON.stringify({
			modelSelection: {
				roleCandidates: ["small", "smol"],
				targetsByProfile: {
					personal: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
				},
			},
		}));
		writeFileSync(join(cwd, ".pi", "answer.json"), JSON.stringify({
			modelSelection: {
				role: "smol",
				targetsByProfile: {
					work: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }],
				},
			},
		}));

		const loaded = loadAnswerConfig(cwd, agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.mergedConfig).toMatchObject({
			modelSelection: {
				role: "smol",
				roleCandidates: ["small", "smol"],
				targetsByProfile: {
					personal: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
					work: [{ provider: "wibey-anthropic", model: "claude-haiku-4-5-20251001" }],
				},
			},
		});

		rmSync(root, { recursive: true, force: true });
	});

	it("records JSON parse errors instead of throwing", () => {
		const root = mkdtempSync(join(tmpdir(), "answer-config-broken-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "answer.json"), "{ not json");

		const loaded = loadAnswerConfig(cwd, agentDir);
		expect(loaded.errors.length).toBe(1);
		expect(loaded.errors[0]!.path).toBe(join(agentDir, "answer.json"));
		expect(loaded.mergedConfig.modelSelection.role).toBeUndefined();
		expect(loaded.mergedConfig.modelSelection.roleCandidates).toBeUndefined();
		expect(loaded.mergedConfig.modelSelection.targets).toBeUndefined();

		rmSync(root, { recursive: true, force: true });
	});
});
