import { describe, expect, it } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Context, type Model } from "@mariozechner/pi-ai";
import { completeWithModelRoleFallback, isRetryableModelFailure, streamWithModelRoleFallback } from "./runtime";
import type { ModelRegistryLike, ResolvedRoleResult } from "./types";

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
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as Model<any>;
}

function makeResponse(model: Model<any>, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "error" ? [] : [{ type: "text", text: `${model.provider}/${model.id}` }],
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function makeRegistry(models: Array<Model<any>>, authenticatedRefs: string[]): ModelRegistryLike {
	const byRef = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
	const authSet = new Set(authenticatedRefs);
	return {
		find(provider, modelId) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return models.filter((model) => authSet.has(`${model.provider}/${model.id}`));
		},
		async getApiKeyAndHeaders(model) {
			if (authSet.has(`${model.provider}/${model.id}`)) return { ok: true, apiKey: "test-key" };
			return { ok: false, error: "missing auth" };
		},
	};
}

function makeResolvedRoleResult(candidates: ResolvedRoleResult["candidates"]): ResolvedRoleResult {
	return {
		model: candidates[0]!.model,
		ref: candidates[0]!.ref,
		thinkingLevel: candidates[0]!.ref.thinkingLevel,
		profile: "work",
		role: "smart",
		matchedRole: candidates[0]!.matchedRole,
		source: "config",
		trace: [],
		candidates,
	};
}

async function collectStreamEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function makeStream(events: AssistantMessageEvent[]) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) stream.push(event);
		stream.end();
	});
	return stream;
}

const context: Context = { messages: [] };

describe("isRetryableModelFailure", () => {
	it("classifies throttling and server errors as retryable", () => {
		expect(isRetryableModelFailure({ response: makeResponse(makeModel("a", "b"), "error", "429 Too Many Requests") })).toBeTrue();
		expect(isRetryableModelFailure({ error: new Error("503 overloaded") })).toBeTrue();
		expect(isRetryableModelFailure({ error: new Error("stream terminated by upstream") })).toBeTrue();
		expect(isRetryableModelFailure({ error: new Error("socket hang up") })).toBeTrue();
		expect(isRetryableModelFailure({ error: new Error("unexpected eof") })).toBeTrue();
		expect(isRetryableModelFailure({ error: new Error("broken pipe") })).toBeTrue();
		expect(isRetryableModelFailure({ error: new Error("Unsupported parameter") })).toBeFalse();
	});
});

describe("completeWithModelRoleFallback", () => {
	it("retries next candidate on retryable response error", async () => {
		const primary = makeModel("code-puppy", "gpt-5.4");
		const secondary = makeModel("wibey-anthropic", "claude-opus-4-6");
		const registry = makeRegistry([primary, secondary], ["code-puppy/gpt-5.4", "wibey-anthropic/claude-opus-4-6"]);
		const result = await completeWithModelRoleFallback({
			resolved: makeResolvedRoleResult([
				{ model: primary, ref: { provider: primary.provider, model: primary.id, thinkingLevel: "high" }, matchedRole: "smart" },
				{ model: secondary, ref: { provider: secondary.provider, model: secondary.id }, matchedRole: "smart" },
			]),
			modelRegistry: registry,
			context,
			completeFn: async (model) => model.id === primary.id
				? makeResponse(model, "error", "429 Too Many Requests")
				: makeResponse(model, "stop"),
		});
		expect(result.candidate.model.id).toBe("claude-opus-4-6");
		expect(result.attempts.map((attempt) => attempt.status)).toEqual(["retryable-response-error", "success"]);
	});

	it("retries next candidate on retryable thrown error", async () => {
		const primary = makeModel("code-puppy", "gpt-5.4");
		const secondary = makeModel("wibey-anthropic", "claude-haiku-4-5-20251001");
		const registry = makeRegistry([primary, secondary], ["code-puppy/gpt-5.4", "wibey-anthropic/claude-haiku-4-5-20251001"]);
		const result = await completeWithModelRoleFallback({
			resolved: makeResolvedRoleResult([
				{ model: primary, ref: { provider: primary.provider, model: primary.id }, matchedRole: "smol" },
				{ model: secondary, ref: { provider: secondary.provider, model: secondary.id }, matchedRole: "smol" },
			]),
			modelRegistry: registry,
			context,
			completeFn: async (model) => {
				if (model.id === primary.id) throw new Error("503 upstream unavailable");
				return makeResponse(model, "stop");
			},
		});
		expect(result.candidate.model.id).toBe("claude-haiku-4-5-20251001");
	});

	it("returns first non-retryable response error without falling through", async () => {
		const primary = makeModel("code-puppy", "gpt-5.4");
		const secondary = makeModel("wibey-anthropic", "claude-opus-4-6");
		const registry = makeRegistry([primary, secondary], ["code-puppy/gpt-5.4", "wibey-anthropic/claude-opus-4-6"]);
		const result = await completeWithModelRoleFallback({
			resolved: makeResolvedRoleResult([
				{ model: primary, ref: { provider: primary.provider, model: primary.id }, matchedRole: "smart" },
				{ model: secondary, ref: { provider: secondary.provider, model: secondary.id }, matchedRole: "smart" },
			]),
			modelRegistry: registry,
			context,
			completeFn: async (model) => model.id === primary.id
				? makeResponse(model, "error", "Unsupported parameter: temperature")
				: makeResponse(model, "stop"),
		});
		expect(result.candidate.model.id).toBe("gpt-5.4");
		expect(result.response.stopReason).toBe("error");
		expect(result.attempts).toHaveLength(1);
	});
});

describe("streamWithModelRoleFallback", () => {
	it("retries the next candidate when the first stream errors before output", async () => {
		const primary = makeModel("code-puppy", "gpt-5.4");
		const secondary = makeModel("wibey-anthropic", "claude-opus-4-6");
		const started: string[] = [];
		const registry = makeRegistry([primary, secondary], ["code-puppy/gpt-5.4", "wibey-anthropic/claude-opus-4-6"]);
		const stream = streamWithModelRoleFallback({
			resolved: makeResolvedRoleResult([
				{ model: primary, ref: { provider: primary.provider, model: primary.id }, matchedRole: "smart" },
				{ model: secondary, ref: { provider: secondary.provider, model: secondary.id }, matchedRole: "smart" },
			]),
			modelRegistry: registry,
			context,
			onAttemptStart: (candidate) => started.push(`${candidate.ref.provider}/${candidate.ref.model}`),
			streamFn: (model) => model.id === primary.id
				? makeStream([
					{ type: "start", partial: makeResponse(model, "error", "429 Too Many Requests") },
					{ type: "error", reason: "error", error: makeResponse(model, "error", "429 Too Many Requests") },
				])
				: makeStream([
					{ type: "start", partial: makeResponse(model, "stop") },
					{ type: "text_start", contentIndex: 0, partial: makeResponse(model, "stop") },
					{ type: "text_delta", contentIndex: 0, delta: "ok", partial: makeResponse(model, "stop") },
					{ type: "text_end", contentIndex: 0, content: "ok", partial: makeResponse(model, "stop") },
					{ type: "done", reason: "stop", message: makeResponse(model, "stop") },
				]),
		});

		const events = await collectStreamEvents(stream);
		expect(started).toEqual(["code-puppy/gpt-5.4", "wibey-anthropic/claude-opus-4-6"]);
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "")).toEqual(["ok"]);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("does not retry after visible output has already been emitted", async () => {
		const primary = makeModel("code-puppy", "gpt-5.4");
		const secondary = makeModel("wibey-anthropic", "claude-opus-4-6");
		const registry = makeRegistry([primary, secondary], ["code-puppy/gpt-5.4", "wibey-anthropic/claude-opus-4-6"]);
		const stream = streamWithModelRoleFallback({
			resolved: makeResolvedRoleResult([
				{ model: primary, ref: { provider: primary.provider, model: primary.id }, matchedRole: "smart" },
				{ model: secondary, ref: { provider: secondary.provider, model: secondary.id }, matchedRole: "smart" },
			]),
			modelRegistry: registry,
			context,
			streamFn: (model) => model.id === primary.id
				? makeStream([
					{ type: "start", partial: makeResponse(model, "error", "503 upstream unavailable") },
					{ type: "text_start", contentIndex: 0, partial: makeResponse(model, "error", "503 upstream unavailable") },
					{ type: "text_delta", contentIndex: 0, delta: "partial", partial: makeResponse(model, "error", "503 upstream unavailable") },
					{ type: "error", reason: "error", error: makeResponse(model, "error", "503 upstream unavailable") },
				])
				: makeStream([
					{ type: "start", partial: makeResponse(model, "stop") },
					{ type: "text_start", contentIndex: 0, partial: makeResponse(model, "stop") },
					{ type: "text_delta", contentIndex: 0, delta: "should-not-run", partial: makeResponse(model, "stop") },
					{ type: "done", reason: "stop", message: makeResponse(model, "stop") },
				]),
		});

		const events = await collectStreamEvents(stream);
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "")).toEqual(["partial"]);
		expect(events.at(-1)?.type).toBe("error");
	});
});
