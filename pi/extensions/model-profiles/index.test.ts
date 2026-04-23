import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import modelProfilesExtension from "./index";
import type { LoadedModelProfilesConfig, ModelProfilesRuntimeState, ModelProfilesState } from "./types";

const MODEL_PROFILES_STATE_CUSTOM_TYPE = "model-profiles-state";
const MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE = "model-profiles-runtime-state";

interface TestHarness {
	handlers: Map<string, Function[]>;
	setModelCalls: Array<{ provider: string; id: string }>;
	statusCalls: Array<{ key: string; value: string | undefined }>;
	runtimeAppends: unknown[];
	modelRegistry: any;
	pi: any;
	ctx: any;
	currentModel: { provider: string; id: string };
}

function buildHarness(opts: {
	flags: Record<string, string | undefined>;
	persistedProfileState?: ModelProfilesState;
}): TestHarness {
	const handlers = new Map<string, Function[]>();
	const setModelCalls: Array<{ provider: string; id: string }> = [];
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const runtimeAppends: unknown[] = [];

	const branchEntries: Array<{ type: string; customType: string; data: unknown }> = [];
	if (opts.persistedProfileState) {
		branchEntries.push({ type: "custom", customType: MODEL_PROFILES_STATE_CUSTOM_TYPE, data: opts.persistedProfileState });
	}
	branchEntries.push({ type: "custom", customType: MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE, data: { selections: {} } satisfies ModelProfilesRuntimeState });

	const currentModel = { provider: "openai-codex", id: "gpt-5.5" };
	const resolvedCandidateModel = { provider: "openai-codex", id: "gpt-5.4", input: ["text"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 };
	const syntheticModel = { provider: "profiles", id: "personal:workhorse" };

	const modelRegistry = {
		find(provider: string, modelId: string) {
			if (provider === currentModel.provider && modelId === currentModel.id) return currentModel as any;
			if (provider === resolvedCandidateModel.provider && modelId === resolvedCandidateModel.id) return resolvedCandidateModel as any;
			if (provider === syntheticModel.provider && modelId === syntheticModel.id) return syntheticModel as any;
			return undefined;
		},
		getAvailable() {
			return [resolvedCandidateModel as any];
		},
		async getApiKeyAndHeaders() {
			return { ok: true } as const;
		},
	};

	const pi = {
		getFlag(name: string) {
			return opts.flags[name];
		},
		registerFlag() {},
		on(event: string, handler: Function) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerProvider() {},
		unregisterProvider() {},
		appendEntry(_type: string, data: unknown) {
			runtimeAppends.push(data);
		},
		async setModel(model: { provider: string; id: string }) {
			setModelCalls.push(model);
			return true;
		},
		setThinkingLevel() {},
		registerCommand() {},
	} satisfies Partial<ExtensionAPI> as ExtensionAPI;

	const ctx = {
		cwd: "/tmp/model-profiles-index-test",
		model: currentModel,
		modelRegistry,
		sessionManager: {
			getBranch() {
				return branchEntries;
			},
		},
		hasUI: true,
		ui: {
			setStatus(key: string, value: string | undefined) {
				statusCalls.push({ key, value });
			},
			notify() {},
		},
	} satisfies Partial<ExtensionContext> as ExtensionContext;

	return { handlers, setModelCalls, statusCalls, runtimeAppends, modelRegistry, pi, ctx, currentModel };
}

describe("model-profiles session_start", () => {
	it("does not override explicit raw model selection with persisted profile state", async () => {
		const harness = buildHarness({
			flags: { model: "gpt-5.5", provider: "openai-codex" },
			persistedProfileState: { activeProfile: "personal", activeRole: "workhorse" },
		});
		modelProfilesExtension(harness.pi);

		const sessionStartHandlers = harness.handlers.get("session_start") ?? [];
		expect(sessionStartHandlers.length).toBeGreaterThan(0);
		for (const handler of sessionStartHandlers) {
			await handler({}, harness.ctx);
		}

		expect(harness.setModelCalls).toEqual([]);
		expect(harness.statusCalls.at(-1)).toEqual({ key: "model-profiles", value: undefined });
	});
});

describe("model-profiles model_select", () => {
	it("suppresses profile status when user manually selects a raw model mid-session", async () => {
		const harness = buildHarness({
			flags: {},
			persistedProfileState: { activeProfile: "personal", activeRole: "workhorse" },
		});
		modelProfilesExtension(harness.pi);

		const sessionStartHandlers = harness.handlers.get("session_start") ?? [];
		for (const handler of sessionStartHandlers) {
			await handler({}, harness.ctx);
		}

		harness.statusCalls.length = 0;

		const modelSelectHandlers = harness.handlers.get("model_select") ?? [];
		expect(modelSelectHandlers.length).toBeGreaterThan(0);
		for (const handler of modelSelectHandlers) {
			await handler({ model: { provider: "openai-codex", id: "gpt-5.5" } }, harness.ctx);
		}

		expect(harness.statusCalls.length).toBeGreaterThan(0);
		expect(harness.statusCalls.at(-1)).toEqual({ key: "model-profiles", value: undefined });
	});

	it("shows profile status when user selects a synthetic profile model mid-session", async () => {
		const harness = buildHarness({
			flags: { model: "gpt-5.5", provider: "openai-codex" },
			persistedProfileState: { activeProfile: "personal", activeRole: "workhorse" },
		});
		modelProfilesExtension(harness.pi);

		const sessionStartHandlers = harness.handlers.get("session_start") ?? [];
		for (const handler of sessionStartHandlers) {
			await handler({}, harness.ctx);
		}

		harness.statusCalls.length = 0;
		harness.ctx.model = { provider: "profiles", id: "personal:workhorse" };

		const modelSelectHandlers = harness.handlers.get("model_select") ?? [];
		for (const handler of modelSelectHandlers) {
			await handler({ model: harness.ctx.model }, harness.ctx);
		}

		expect(harness.statusCalls.length).toBeGreaterThan(0);
		expect(harness.statusCalls.at(-1)?.value).toBe("personal:workhorse");
	});
});
