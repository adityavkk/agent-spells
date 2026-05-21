import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProfileBackedModel } from "./profile-model-resolver";

describe("resolveProfileBackedModel", () => {
	it("returns raw models unchanged", async () => {
		const model = { provider: "anthropic", id: "claude" };
		await expect(resolveProfileBackedModel({ cwd: "/tmp", model, modelRegistry: {} as any, entries: [] })).resolves.toEqual(model);
	});

	it("resolves synthetic profile models to configured concrete targets", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "provider-profile-model-"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "model-profiles.json"), JSON.stringify({
			profiles: {
				work: {
					roles: {
						workhorse: {
							targets: [
								{ provider: "openai-codex", model: "gpt-5.4" },
								{ provider: "anthropic", model: "claude-sonnet-4" },
							],
						},
					},
				},
			},
		}));
		const models = [
			{ provider: "openai-codex", id: "gpt-5.4" },
			{ provider: "anthropic", id: "claude-sonnet-4" },
		];
		const modelRegistry = {
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id);
			},
			getAvailable() { return models; },
			async getApiKeyAndHeaders() { return { ok: true } as const; },
		} as any;

		await expect(resolveProfileBackedModel({
			cwd,
			model: { provider: "profiles", id: "work:workhorse" },
			modelRegistry,
			entries: [],
		})).resolves.toEqual(models[0]);
	});

	it("prefers model-profiles sticky runtime winners", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "provider-profile-winner-"));
		const modelRegistry = {
			find() { return undefined; },
			getAvailable() { return []; },
			async getApiKeyAndHeaders() { return { ok: false, error: "none" } as const; },
		} as any;
		await expect(resolveProfileBackedModel({
			cwd,
			model: { provider: "profiles", id: "work:smart" },
			modelRegistry,
			entries: [{
				type: "custom",
				customType: "model-profiles-runtime-state",
				data: { selections: { "work:smart": { lastWinner: { provider: "anthropic", model: "claude-opus" } } } },
			}],
		})).resolves.toEqual({ provider: "anthropic", id: "claude-opus" });
	});
});
