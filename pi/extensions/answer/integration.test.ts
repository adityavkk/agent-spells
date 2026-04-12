import { describe, expect, it } from "bun:test";
import { complete, type Model } from "@mariozechner/pi-ai";
import { buildBamlExtractionContext, parseBamlExtractionResult } from "./extraction";

const ollamaBaseUrl = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/v1\/?$/, "");

async function isOllamaAvailable(): Promise<boolean> {
	const base = ollamaBaseUrl;
	try {
		const response = await fetch(`${base}/api/tags`);
		return response.ok;
	} catch {
		return false;
	}
}

const runE2E = process.env.PI_ANSWER_E2E === "0" ? false : await isOllamaAvailable();
const suite = runE2E ? describe : describe.skip;

const model: Model<"openai-completions"> = {
	id: process.env.PI_ANSWER_E2E_MODEL ?? "gemma4:e4b",
	name: `BAML extraction ${process.env.PI_ANSWER_E2E_MODEL ?? "gemma4:e4b"}`,
	api: "openai-completions",
	provider: "ollama",
	baseUrl: `${ollamaBaseUrl}/v1`,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
	compat: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	},
};

function getText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

suite("answer extension llm integration", () => {
	it("extracts text, single-choice, and multiple-choice questions through baml request+parse with pi transport", { timeout: 240_000 }, async () => {
		const context = await buildBamlExtractionContext([
			"Ask the user these food questions in order:",
			"1. What's your ideal spice level?",
			"2. Pick one base for your bowl: Rice, Salad, Wrap, or Noodles.",
			"3. Select all toppings you want: Chicken, Tofu, Beans, Cheese. You can also add your own topping.",
		].join("\n"));

		const response = await complete(model, context, { apiKey: "ollama", temperature: 0 });
		const parsed = parseBamlExtractionResult(getText(response));
		expect(parsed.questions).toHaveLength(3);

		expect(parsed.questions[0]).toEqual({
			question: "What's your ideal spice level?",
			type: "text",
			options: [],
			allowOther: false,
			otherLabel: "Other",
		});

		expect(parsed.questions[1]).toEqual(expect.objectContaining({
			question: "Pick one base for your bowl:",
			type: "single_choice",
			allowOther: false,
			otherLabel: "Other",
		}));
		expect(parsed.questions[1]!.options.map((option) => option.label)).toEqual(["Rice", "Salad", "Wrap", "Noodles"]);

		expect(parsed.questions[2]).toEqual(expect.objectContaining({
			question: "Select all toppings you want:",
			type: "multiple_choice",
			allowOther: true,
		}));
		expect(parsed.questions[2]!.options.map((option) => option.label)).toEqual(["Chicken", "Tofu", "Beans", "Cheese"]);
	});
});
