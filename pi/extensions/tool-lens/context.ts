/**
 * Build a compact, redacted view of recent session conversation for analyzer
 * prompts. Default is visible-recent: the last N messages, char-bounded, with
 * system prompt and context files opt-in (privacy default off).
 */
import { redactText } from "./redaction";
import type { ToolLensConfig } from "./types";

/** Structural view of a session message (role + text content). */
export interface ConversationMessageLike {
	role?: string;
	customType?: string;
	content?: unknown;
}

export interface BuiltContext {
	text: string;
	messageCount: number;
	truncated: boolean;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
		} else if (block && typeof block === "object") {
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
			else if (record.type === "tool_result" || record.type === "toolResult") parts.push("[tool result]");
		}
	}
	return parts.join("\n").trim();
}

function roleLabel(message: ConversationMessageLike): string {
	if (message.role === "assistant") return "assistant";
	if (message.role === "user") return "user";
	if (message.role === "toolResult") return "tool";
	if (message.role === "custom") return `custom:${message.customType ?? "?"}`;
	return message.role ?? "unknown";
}

/**
 * Select and format the most recent conversation messages, oldest-first, within
 * message and char budgets. Tool-lens own cards are skipped. Output is redacted.
 */
export function buildConversationContext(
	messages: ConversationMessageLike[],
	config: ToolLensConfig,
): BuiltContext {
	const { maxMessages, maxChars, includePriorToolResults } = config.context;
	const eligible = messages.filter((message) => {
		if (message.role === "custom") return false; // never feed extension cards back in
		if (message.role === "toolResult" && !includePriorToolResults) return false;
		return true;
	});

	const recent = maxMessages > 0 ? eligible.slice(-maxMessages) : eligible;
	const lines: string[] = [];
	for (const message of recent) {
		const text = textFromContent(message.content);
		if (!text) continue;
		lines.push(`${roleLabel(message)}: ${text}`);
	}

	const joined = redactText(lines.join("\n\n"), config.redaction).text;
	const truncated = maxChars > 0 && joined.length > maxChars;
	const text = truncated ? `…${joined.slice(joined.length - maxChars)}` : joined;
	return { text, messageCount: recent.length, truncated };
}
