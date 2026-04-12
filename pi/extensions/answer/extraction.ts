import type { Context } from "@mariozechner/pi-ai";
import { b } from "../../../baml_client";
import { normalizeQuestion, type ExtractionResult, type RawQuestion } from "./core";

function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => typeof item === "string"
				? item
				: item && typeof item === "object" && "text" in item && typeof item.text === "string"
					? item.text
					: JSON.stringify(item))
			.join("\n");
	}
	return JSON.stringify(content);
}

function stripJsonFence(text: string): string {
	const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	return match ? match[1]!.trim() : text;
}

export async function buildBamlExtractionContext(input: string): Promise<Pick<Context, "systemPrompt" | "messages">> {
	const req = await b.request.ExtractQuestions(input);
	const body = req.body.json() as {
		messages?: Array<{ role: string; content: unknown }>;
	};
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const systemMessages = messages.filter((message) => message.role === "system");
	const nonSystemMessages = messages.filter((message) => message.role !== "system");

	return {
		systemPrompt: systemMessages.map((message) => contentToString(message.content)).join("\n\n"),
		messages: nonSystemMessages.map((message) => ({
			role: message.role as "user" | "assistant",
			content: contentToString(message.content),
		})),
	};
}

export function parseBamlExtractionResult(text: string): ExtractionResult {
	const parsed = (() => {
		try {
			return b.parse.ExtractQuestions(text);
		} catch {
			return b.parse.ExtractQuestions(stripJsonFence(text));
		}
	})();
	return {
		questions: parsed.questions
			.map((question): RawQuestion => ({
				question: question.question,
				context: question.context,
				type: question.type,
				options: question.options.map((option) => ({
					label: option.label,
					value: option.value,
					description: option.description,
				})),
				allowOther: question.allowOther,
				otherLabel: question.otherLabel,
				answerInstructions: question.answerInstructions,
				constraints: question.constraints
					? {
						minSelections: question.constraints.minSelections,
						maxSelections: question.constraints.maxSelections,
						minSentences: question.constraints.minSentences,
						maxSentences: question.constraints.maxSentences,
					}
					: undefined,
			}))
			.map(normalizeQuestion)
			.filter((question): question is NonNullable<ReturnType<typeof normalizeQuestion>> => question !== null),
	};
}
