/**
 * Transcript handling for the recap: fingerprinting the current branch,
 * digesting session-context messages into compact plain text for the cheap
 * model, and reading back persisted recap entries (delta base).
 *
 * Everything here is pure over session entries / messages.
 */
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { RECAP_ENTRY_CUSTOM_TYPE, type RecapEntryData } from "./types";

/** Approximate chars-per-token used to apply the maxInputTokens cap. */
export const CHARS_PER_TOKEN = 4;

/** Minimal structural view of an AgentMessage; avoids depending on app-specific custom roles. */
interface MessageLike {
	role: string;
	content: unknown;
	stopReason?: string;
	toolName?: string;
	isError?: boolean;
}

interface ContentBlockLike {
	type: string;
	text?: string;
	name?: string;
	thinking?: string;
}

/**
 * Fingerprint of the current conversation branch. Built from message entries
 * only, so our own appendEntry (a custom entry) never invalidates the cache,
 * while new turns, compaction, and tree navigation all change it.
 */
export function computeTranscriptFingerprint(branch: readonly SessionEntry[]): string {
	let messageCount = 0;
	let compactionCount = 0;
	let lastMessageId = "none";
	for (const entry of branch) {
		if (entry.type === "message") {
			messageCount += 1;
			lastMessageId = entry.id;
		} else if (entry.type === "compaction") {
			compactionCount += 1;
		}
	}
	return `${lastMessageId}:${messageCount}:${compactionCount}`;
}

/** Count compaction entries on the branch (delta-base validity guard). */
export function countCompactions(branch: readonly SessionEntry[]): number {
	let count = 0;
	for (const entry of branch) {
		if (entry.type === "compaction") count += 1;
	}
	return count;
}

/** Count completed turns (assistant messages that stopped normally) on the branch. */
export function countCompletedTurns(branch: readonly SessionEntry[]): number {
	let turns = 0;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role === "assistant" && message.stopReason === "stop") turns += 1;
	}
	return turns;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlockLike[])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function toolCallsFromContent(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return (content as ContentBlockLike[])
		.filter((block) => block.type === "toolCall" && typeof block.name === "string")
		.map((block) => block.name as string);
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** One digest line per message; empty string when the message adds nothing. */
function digestMessage(message: MessageLike): string {
	if (message.role === "user") {
		const text = compactWhitespace(textFromContent(message.content));
		return text ? `USER: ${clip(text, 600)}` : "";
	}
	if (message.role === "assistant") {
		const text = compactWhitespace(textFromContent(message.content));
		const tools = toolCallsFromContent(message.content);
		const toolSuffix = tools.length > 0 ? ` [tools: ${tools.join(", ")}]` : "";
		if (!text && !toolSuffix) return "";
		return `ASSISTANT: ${clip(text, 800)}${toolSuffix}`;
	}
	if (message.role === "toolResult") {
		const text = compactWhitespace(textFromContent(message.content));
		const label = message.isError ? "TOOL ERROR" : "TOOL";
		return text ? `${label} ${message.toolName ?? "?"}: ${clip(text, 240)}` : "";
	}
	// Custom app messages (e.g. extension cards) are not part of the recap.
	return "";
}

export interface RecapDigest {
	/** Plain-text digest sent to the recap model. */
	text: string;
	/** Total messages the digest covers (delta cursor for the next recap). */
	messageCount: number;
}

export interface BuildDigestOptions {
	maxInputTokens: number;
	/**
	 * Delta mode: index of the first message not covered by the previous
	 * recap. When set and valid, only messages from this index on are
	 * digested (the previous recap text travels in the prompt instead).
	 */
	sinceMessageIndex?: number;
}

/**
 * Digest session-context messages into capped plain text.
 *
 * The cap keeps the head (the first user message anchors what the session is
 * about) and the most recent tail, dropping the middle — long sessions stay
 * within budget while preserving "what is this" and "what just happened".
 */
export function buildRecapDigest(messages: readonly unknown[], options: BuildDigestOptions): RecapDigest {
	const messageCount = messages.length;
	const startIndex =
		options.sinceMessageIndex !== undefined &&
		options.sinceMessageIndex > 0 &&
		options.sinceMessageIndex < messageCount
			? options.sinceMessageIndex
			: 0;

	const lines: string[] = [];
	for (let i = startIndex; i < messageCount; i++) {
		const line = digestMessage(messages[i] as MessageLike);
		if (line) lines.push(line);
	}

	const maxChars = Math.max(1_000, options.maxInputTokens * CHARS_PER_TOKEN);
	let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
	if (total > maxChars && lines.length > 2) {
		// Keep the first line and as much of the tail as fits.
		const head = lines[0] as string;
		const tail: string[] = [];
		let budget = maxChars - head.length - "[… earlier activity truncated …]".length - 2;
		for (let i = lines.length - 1; i >= 1 && budget > 0; i--) {
			const line = lines[i] as string;
			if (line.length + 1 > budget) break;
			tail.unshift(line);
			budget -= line.length + 1;
		}
		lines.length = 0;
		lines.push(head, "[… earlier activity truncated …]", ...tail);
		total = lines.reduce((sum, line) => sum + line.length + 1, 0);
	}
	if (total > maxChars && lines.length > 0) {
		// Degenerate case: even head+tail overflow; hard-clip from the end.
		const joined = lines.join("\n");
		return { text: joined.slice(joined.length - maxChars), messageCount };
	}
	return { text: lines.join("\n"), messageCount };
}

/** Most recent persisted recap entry on the branch, if any. */
export function readLastRecapEntry(branch: readonly SessionEntry[]): RecapEntryData | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom") continue;
		if (entry.customType !== RECAP_ENTRY_CUSTOM_TYPE) continue;
		return normalizeRecapEntryData(entry.data);
	}
	return undefined;
}

function normalizeRecapEntryData(data: unknown): RecapEntryData | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.text !== "string" || typeof record.fingerprint !== "string") return undefined;
	if (typeof record.messageCount !== "number" || typeof record.generatedAt !== "number") return undefined;
	if (typeof record.compactionCount !== "number") return undefined;
	const source = record.source === "command" ? "command" : "auto";
	return {
		text: record.text,
		fingerprint: record.fingerprint,
		messageCount: record.messageCount,
		compactionCount: record.compactionCount,
		generatedAt: record.generatedAt,
		source,
	};
}
