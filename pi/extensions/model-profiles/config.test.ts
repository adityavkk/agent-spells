import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getGlobalModelProfilesPath,
	loadModelProfilesConfig,
	mergeModelProfilesConfig,
	normalizeModelProfilesConfig,
	normalizeModelProfilesState,
} from "./config";

describe("normalizeModelProfilesConfig", () => {
	it("normalizes legacy single-target role config", () => {
		expect(normalizeModelProfilesConfig({
			activeProfile: "  work  ",
			profiles: {
				" work ": {
					defaultRole: " workhorse ",
					roles: {
						" small ": {
							provider: " openai-codex ",
							model: " gpt-5.4-mini ",
							thinkingLevel: "MINIMAL",
							fallback: [" workhorse ", "", "workhorse", " smart "],
						},
					},
				},
			},
		})).toEqual({
			activeProfile: "work",
			profiles: {
				work: {
					defaultRole: "workhorse",
					roles: {
						small: {
							provider: "openai-codex",
							model: "gpt-5.4-mini",
							thinkingLevel: "minimal",
							targets: undefined,
							fallback: ["workhorse", "smart"],
						},
					},
				},
			},
		});
	});

	it("normalizes ordered target lists", () => {
		expect(normalizeModelProfilesConfig({
			profiles: {
				work: {
					roles: {
						smart: {
							targets: [
								{ provider: " code-puppy ", model: " gpt-5.4 ", thinkingLevel: "HIGH" },
								{ provider: " wibey-anthropic ", model: " claude-opus-4-6 " },
								{ provider: "", model: "skip-me" },
							],
						},
					},
				},
			},
		})).toEqual({
			profiles: {
				work: {
					roles: {
						smart: {
							provider: undefined,
							model: undefined,
							thinkingLevel: undefined,
							targets: [
								{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
								{ provider: "wibey-anthropic", model: "claude-opus-4-6", thinkingLevel: undefined },
							],
							fallback: undefined,
						},
					},
					defaultRole: undefined,
				},
			},
			activeProfile: undefined,
		});
	});
});

describe("mergeModelProfilesConfig", () => {
	it("merges project overrides shallowly by profile and role", () => {
		expect(mergeModelProfilesConfig({
			activeProfile: "work",
			profiles: {
				work: {
					defaultRole: "workhorse",
					roles: {
						small: {
							provider: "openai-codex",
							model: "gpt-5.4-mini",
						},
					},
				},
			},
		}, {
			profiles: {
				work: {
					roles: {
						small: {
							thinkingLevel: "minimal",
						},
						smart: {
							targets: [
								{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
								{ provider: "wibey-anthropic", model: "claude-opus-4-6" },
							],
						},
					},
				},
			},
		})).toEqual({
			activeProfile: "work",
			profiles: {
				work: {
					defaultRole: "workhorse",
					roles: {
						small: {
							provider: "openai-codex",
							model: "gpt-5.4-mini",
							thinkingLevel: "minimal",
							targets: undefined,
							fallback: undefined,
						},
						smart: {
							provider: undefined,
							model: undefined,
							thinkingLevel: undefined,
							targets: [
								{ provider: "code-puppy", model: "gpt-5.4", thinkingLevel: "high" },
								{ provider: "wibey-anthropic", model: "claude-opus-4-6" },
							],
							fallback: undefined,
						},
					},
				},
			},
		});
	});
});

describe("loadModelProfilesConfig", () => {
	it("loads global + project config files and records parse errors", () => {
		const root = mkdtempSync(join(tmpdir(), "model-profiles-config-"));
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		writeFileSync(getGlobalModelProfilesPath(agentDir), JSON.stringify({
			activeProfile: "work",
			profiles: {
				work: {
					defaultRole: "workhorse",
					roles: {
						small: {
							provider: "openai-codex",
							model: "gpt-5.4-mini",
						},
					},
				},
			},
		}));
		writeFileSync(join(cwd, ".pi", "model-profiles.json"), "{not-json");

		const loaded = loadModelProfilesConfig(cwd, agentDir);
		expect(loaded.globalConfig.activeProfile).toBe("work");
		expect(loaded.projectConfig).toEqual({ profiles: {} });
		expect(loaded.mergedConfig.activeProfile).toBe("work");
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]?.path).toBe(join(cwd, ".pi", "model-profiles.json"));
	});
});

describe("normalizeModelProfilesState", () => {
	it("keeps only trimmed active profile + role strings", () => {
		expect(normalizeModelProfilesState({
			activeProfile: " work ",
			activeRole: " small ",
			noise: true,
		})).toEqual({
			activeProfile: "work",
			activeRole: "small",
		});
	});
});
