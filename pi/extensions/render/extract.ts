import type { Context } from "@mariozechner/pi-ai";
import { b } from "./baml_client";
import type { RenderDoc } from "./baml_client/types";
import { normalizeRenderDoc } from "./normalize";

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

export async function buildBamlRenderContext(input: string): Promise<Pick<Context, "systemPrompt" | "messages">> {
	const req = await b.request.ExtractRenderDoc(input);
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

export function parseBamlRenderResult(text: string, options?: { fallbackMarkdown?: string; defaultTitle?: string }): RenderDoc {
	const parsed = (() => {
		try {
			return b.parse.ExtractRenderDoc(text);
		} catch {
			return b.parse.ExtractRenderDoc(stripJsonFence(text));
		}
	})();
	return normalizeRenderDoc(parsed, options);
}
