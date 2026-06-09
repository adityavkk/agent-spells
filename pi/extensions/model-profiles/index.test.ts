import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Context, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import modelProfilesExtension from "./index";
import { MODEL_PROFILES_PROVIDER } from "./types";
import type { ModelProfilesRuntimeState, ModelProfilesState, ModelRegistryLike } from "./types";

const MODEL_PROFILES_STATE_CUSTOM_TYPE = "model-profiles-state";
const MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE = "model-profiles-runtime-state";

interface TestHarness {
	handlers: Map<string, Function[]>;
	setModelCalls: Array<{ provider: string; id: string }>;
	statusCalls: Array<{ key: string; value: string | undefined }>;
	runtimeAppends: unknown[];
	eventHandlers: Map<string, Function[]>;
	registeredProviders: Map<string, any>;
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
	const eventHandlers = new Map<string, Function[]>();
	const registeredProviders = new Map<string, any>();

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
		registerProvider(provider: string, config: any) {
			registeredProviders.set(provider, config);
		},
		unregisterProvider(provider: string) {
			registeredProviders.delete(provider);
		},
		appendEntry(_type: string, data: unknown) {
			runtimeAppends.push(data);
		},
		async setModel(model: { provider: string; id: string }) {
			setModelCalls.push(model);
			return true;
		},
		setThinkingLevel() {},
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: Function) {
				eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
				return () => {
					eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
				};
			},
		},
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

	return { handlers, setModelCalls, statusCalls, runtimeAppends, eventHandlers, registeredProviders, modelRegistry, pi, ctx, currentModel };
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

	it("does not override explicit raw model selection when built-in flags are only present in argv", async () => {
		const originalArgv = [...process.argv];
		process.argv = ["node", "pi", "--provider", "openai-codex", "--model", "gpt-5.5"];
		try {
			const harness = buildHarness({
				flags: {},
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
		} finally {
			process.argv = originalArgv;
		}
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

function makeModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as Model<any>;
}

function makeAssistantMessage(model: Model<any>, text = "ok"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeRegistry(models: Array<Model<any>>): ModelRegistryLike {
	const byRef = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
	return {
		find(provider, modelId) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return models;
		},
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test-key" } as const;
		},
	};
}

function makeSuccessStream(model: Model<any>, text = "ok") {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = makeAssistantMessage(model, text);
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("model-profiles synthetic provider registry fallback", () => {
	it("uses a lazy file-backed registry fallback before session_start provides ctx.modelRegistry", async () => {
		const originalCwd = process.cwd();
		const tmp = mkdtempSync(join(tmpdir(), "model-profiles-registry-"));
		const target = makeModel("openai-codex", "gpt-5.4");
		const fallbackRegistry = makeRegistry([target]);
		const attemptedModels: string[] = [];

		try {
			mkdirSync(join(tmp, ".pi"), { recursive: true });
			writeFileSync(join(tmp, ".pi", "model-profiles.json"), JSON.stringify({
				profiles: {
					personal: {
						defaultRole: "workhorse",
						roles: {
							workhorse: {
								targets: [{ provider: target.provider, model: target.id, thinkingLevel: "high" }],
							},
						},
					},
				},
			}, null, 2));
			process.chdir(tmp);

			const harness = buildHarness({ flags: {} });
			modelProfilesExtension(harness.pi, {
				createFallbackModelRegistry: () => fallbackRegistry,
				streamFn: (model) => {
					attemptedModels.push(`${model.provider}/${model.id}`);
					return makeSuccessStream(model);
				},
			});

			const provider = harness.registeredProviders.get(MODEL_PROFILES_PROVIDER);
			expect(provider).toBeTruthy();
			const syntheticModel = provider.models.find((model: Model<any>) => model.id === "personal:workhorse") as Model<any> | undefined;
			expect(syntheticModel).toBeTruthy();
			const events = await collectEvents(provider.streamSimple(syntheticModel, { messages: [] } satisfies Context));

			expect(attemptedModels).toEqual(["openai-codex/gpt-5.4"]);
			expect(events.at(-1)?.type).toBe("done");
			expect(events.some((event) => event.type === "error" && event.error.errorMessage?.includes("Model registry unavailable for synthetic profiles provider"))).toBeFalse();
		} finally {
			process.chdir(originalCwd);
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
