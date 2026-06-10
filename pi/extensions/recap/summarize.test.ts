import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ModelRegistryLike, ResolvedRoleResult } from "../model-profiles/types";
import {
	buildRecapContext,
	DEFAULT_RECAP_SYSTEM_PROMPT,
	describeResolvedModel,
	runRecapCompletion,
	sanitizeRecapText,
} from "./summarize";

function makeModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		baseUrl: "http://localhost:8110/wibey",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as Model<any>;
}

const MODEL = makeModel("wibey-anthropic", "claude-haiku-4-5-20251001");

function makeResolved(): ResolvedRoleResult {
	return {
		model: MODEL,
		ref: { provider: MODEL.provider, model: MODEL.id },
		source: "config",
		trace: [],
		candidates: [{ model: MODEL, ref: { provider: MODEL.provider, model: MODEL.id } }],
	};
}

const REGISTRY: ModelRegistryLike = {
	find: () => MODEL,
	getAvailable: () => [MODEL],
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
};

function response(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Recap line." }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

describe("buildRecapContext", () => {
	it("builds a full-transcript prompt with the default instructions", () => {
		const context = buildRecapContext({ digest: "USER: hi" });
		expect(context.systemPrompt).toBe(DEFAULT_RECAP_SYSTEM_PROMPT);
		expect(context.tools).toEqual([]);
		expect(context.messages).toHaveLength(1);
		const text = (context.messages[0]!.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain("Session transcript digest:");
		expect(text).toContain("USER: hi");
		expect(text).not.toContain("Previous recap");
	});

	it("folds new activity into the previous recap in delta mode", () => {
		const context = buildRecapContext({ digest: "TOOL run_tests: passing", previousRecap: "Migrating auth." });
		const text = (context.messages[0]!.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain("Previous recap (the session so far):\nMigrating auth.");
		expect(text).toContain("New activity since that recap:\nTOOL run_tests: passing");
	});

	it("honors a custom system prompt", () => {
		const context = buildRecapContext({ digest: "x", systemPrompt: "Custom rules." });
		expect(context.systemPrompt).toBe("Custom rules.");
	});
});

describe("sanitizeRecapText", () => {
	it("trims, takes the first non-empty line, and strips labels/quotes", () => {
		expect(sanitizeRecapText("  Fixing auth tests.  ")).toBe("Fixing auth tests.");
		expect(sanitizeRecapText("\n\nFirst line.\nSecond line.")).toBe("First line.");
		expect(sanitizeRecapText("Recap: working on widget")).toBe("working on widget");
		expect(sanitizeRecapText('"Quoted recap."')).toBe("Quoted recap.");
		expect(sanitizeRecapText("'Single quoted.'")).toBe("Single quoted.");
	});

	it("returns empty string for whitespace-only output", () => {
		expect(sanitizeRecapText("   \n  ")).toBe("");
	});
});

describe("runRecapCompletion", () => {
	it("returns sanitized text on success", async () => {
		const result = await runRecapCompletion({
			resolved: makeResolved(),
			modelRegistry: REGISTRY,
			context: buildRecapContext({ digest: "USER: hi" }),
			timeoutMs: 5_000,
			completeFn: async () => response({ content: [{ type: "text", text: '"Recap: did the thing."' }] }),
		});
		expect(result).toEqual({ status: "success", text: "did the thing." });
	});

	it("maps provider errors to error results (fail silent upstream)", async () => {
		const result = await runRecapCompletion({
			resolved: makeResolved(),
			modelRegistry: REGISTRY,
			context: buildRecapContext({ digest: "USER: hi" }),
			timeoutMs: 5_000,
			completeFn: async () => response({ stopReason: "error", errorMessage: "boom", content: [] }),
		});
		expect(result.status).toBe("error");
		if (result.status === "error") expect(result.message).toContain("boom");
	});

	it("treats empty model output as an error", async () => {
		const result = await runRecapCompletion({
			resolved: makeResolved(),
			modelRegistry: REGISTRY,
			context: buildRecapContext({ digest: "USER: hi" }),
			timeoutMs: 5_000,
			completeFn: async () => response({ content: [{ type: "text", text: "   " }] }),
		});
		expect(result.status).toBe("error");
	});

	it("maps aborted responses to aborted", async () => {
		const result = await runRecapCompletion({
			resolved: makeResolved(),
			modelRegistry: REGISTRY,
			context: buildRecapContext({ digest: "USER: hi" }),
			timeoutMs: 5_000,
			completeFn: async () => response({ stopReason: "aborted", content: [] }),
		});
		expect(result).toEqual({ status: "aborted" });
	});

	it("aborts when the timeout elapses", async () => {
		const result = await runRecapCompletion({
			resolved: makeResolved(),
			modelRegistry: REGISTRY,
			context: buildRecapContext({ digest: "USER: hi" }),
			timeoutMs: 20,
			completeFn: (_model, _context, options) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener("abort", () =>
						resolve(response({ stopReason: "aborted", content: [] })),
					);
				}),
		});
		expect(result).toEqual({ status: "aborted" });
	});

	it("converts thrown errors into error results instead of propagating", async () => {
		const result = await runRecapCompletion({
			resolved: makeResolved(),
			modelRegistry: REGISTRY,
			context: buildRecapContext({ digest: "USER: hi" }),
			timeoutMs: 5_000,
			completeFn: async () => {
				throw new Error("connection refused");
			},
		});
		expect(result.status).toBe("error");
		if (result.status === "error") expect(result.message).toContain("connection refused");
	});
});

describe("describeResolvedModel", () => {
	it("labels provider/model", () => {
		expect(describeResolvedModel(makeResolved())).toBe("wibey-anthropic/claude-haiku-4-5-20251001");
	});
});
