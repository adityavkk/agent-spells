import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	buildRecapDigest,
	computeTranscriptFingerprint,
	countCompactions,
	countCompletedTurns,
	readLastRecapEntry,
} from "./transcript";
import { RECAP_ENTRY_CUSTOM_TYPE, type RecapEntryData } from "./types";

let nextId = 0;

function id(): string {
	return `e${++nextId}`;
}

function userEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: id(),
		parentId: null,
		timestamp: "2026-06-10T00:00:00Z",
		message: { role: "user", content: text, timestamp: 0 },
	} as SessionEntry;
}

function assistantEntry(text: string, options: { stopReason?: string; tools?: string[] } = {}): SessionEntry {
	const content: Array<Record<string, unknown>> = [];
	if (text) content.push({ type: "text", text });
	for (const name of options.tools ?? []) content.push({ type: "toolCall", id: id(), name, arguments: {} });
	return {
		type: "message",
		id: id(),
		parentId: null,
		timestamp: "2026-06-10T00:00:00Z",
		message: {
			role: "assistant",
			content,
			stopReason: options.stopReason ?? "stop",
			timestamp: 0,
		},
	} as unknown as SessionEntry;
}

function customEntry(customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id: id(),
		parentId: null,
		timestamp: "2026-06-10T00:00:00Z",
		customType,
		data,
	} as SessionEntry;
}

function compactionEntry(): SessionEntry {
	return {
		type: "compaction",
		id: id(),
		parentId: null,
		timestamp: "2026-06-10T00:00:00Z",
	} as unknown as SessionEntry;
}

function recapEntryData(overrides: Partial<RecapEntryData> = {}): RecapEntryData {
	return {
		text: "recap text",
		fingerprint: "fp",
		messageCount: 4,
		compactionCount: 0,
		generatedAt: 123,
		source: "auto",
		...overrides,
	};
}

describe("computeTranscriptFingerprint", () => {
	it("changes when messages are added", () => {
		const branch = [userEntry("a"), assistantEntry("b")];
		const before = computeTranscriptFingerprint(branch);
		const after = computeTranscriptFingerprint([...branch, userEntry("c")]);
		expect(before).not.toBe(after);
	});

	it("is stable across our own custom entries (appendEntry must not invalidate the cache)", () => {
		const branch = [userEntry("a"), assistantEntry("b")];
		const before = computeTranscriptFingerprint(branch);
		const after = computeTranscriptFingerprint([...branch, customEntry(RECAP_ENTRY_CUSTOM_TYPE, recapEntryData())]);
		expect(before).toBe(after);
	});

	it("changes when a compaction rewrites the transcript", () => {
		const branch = [userEntry("a"), assistantEntry("b")];
		const before = computeTranscriptFingerprint(branch);
		const after = computeTranscriptFingerprint([...branch, compactionEntry()]);
		expect(before).not.toBe(after);
	});
});

describe("turn and compaction counting", () => {
	it("counts only completed assistant turns", () => {
		const branch = [
			userEntry("q1"),
			assistantEntry("a1"),
			userEntry("q2"),
			assistantEntry("a2", { stopReason: "aborted" }),
			assistantEntry("a3"),
		];
		expect(countCompletedTurns(branch)).toBe(2);
	});

	it("counts compaction entries", () => {
		expect(countCompactions([userEntry("a")])).toBe(0);
		expect(countCompactions([userEntry("a"), compactionEntry(), compactionEntry()])).toBe(2);
	});
});

describe("buildRecapDigest", () => {
	const messages = [
		{ role: "user", content: "migrate auth to JWT", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Starting the migration." },
				{ type: "toolCall", name: "read_file" },
				{ type: "toolCall", name: "edit_file" },
			],
			stopReason: "stop",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolName: "edit_file",
			content: [{ type: "text", text: "edited auth/token.ts" }],
			isError: false,
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolName: "run_tests",
			content: [{ type: "text", text: "2 tests failing" }],
			isError: true,
			timestamp: 0,
		},
	];

	it("digests user, assistant (with tool calls), and tool results", () => {
		const digest = buildRecapDigest(messages, { maxInputTokens: 12_000 });
		expect(digest.messageCount).toBe(4);
		expect(digest.text).toContain("USER: migrate auth to JWT");
		expect(digest.text).toContain("ASSISTANT: Starting the migration. [tools: read_file, edit_file]");
		expect(digest.text).toContain("TOOL edit_file: edited auth/token.ts");
		expect(digest.text).toContain("TOOL ERROR run_tests: 2 tests failing");
	});

	it("skips empty and unknown-role messages", () => {
		const digest = buildRecapDigest(
			[
				{ role: "user", content: "   ", timestamp: 0 },
				{ role: "weird-custom", content: "ignore me", timestamp: 0 },
				{ role: "user", content: "real question", timestamp: 0 },
			],
			{ maxInputTokens: 12_000 },
		);
		expect(digest.text).toBe("USER: real question");
		expect(digest.messageCount).toBe(3);
	});

	it("digests only messages after sinceMessageIndex in delta mode", () => {
		const digest = buildRecapDigest(messages, { maxInputTokens: 12_000, sinceMessageIndex: 2 });
		expect(digest.text).not.toContain("USER:");
		expect(digest.text).not.toContain("ASSISTANT:");
		expect(digest.text).toContain("TOOL edit_file");
		expect(digest.messageCount).toBe(4);
	});

	it("ignores an out-of-range delta cursor", () => {
		const digest = buildRecapDigest(messages, { maxInputTokens: 12_000, sinceMessageIndex: 99 });
		expect(digest.text).toContain("USER: migrate auth to JWT");
	});

	it("keeps the head and recent tail when over budget", () => {
		const long = Array.from({ length: 200 }, (_, i) => ({
			role: "user",
			content: `message number ${i} ${"x".repeat(80)}`,
			timestamp: 0,
		}));
		const digest = buildRecapDigest(long, { maxInputTokens: 500 });
		expect(digest.text.length).toBeLessThanOrEqual(500 * 4 + 100);
		expect(digest.text).toContain("message number 0");
		expect(digest.text).toContain("message number 199");
		expect(digest.text).toContain("[… earlier activity truncated …]");
		expect(digest.text).not.toContain("message number 100 ");
	});

	it("compacts whitespace and clips very long messages", () => {
		const digest = buildRecapDigest(
			[{ role: "user", content: `a\n\n\tb   c ${"d".repeat(2000)}`, timestamp: 0 }],
			{ maxInputTokens: 12_000 },
		);
		expect(digest.text.startsWith("USER: a b c d")).toBe(true);
		expect(digest.text.length).toBeLessThan(700);
		expect(digest.text.endsWith("…")).toBe(true);
	});
});

describe("readLastRecapEntry", () => {
	it("returns undefined when no recap entry exists", () => {
		expect(readLastRecapEntry([userEntry("a")])).toBeUndefined();
	});

	it("returns the most recent valid entry", () => {
		const branch = [
			customEntry(RECAP_ENTRY_CUSTOM_TYPE, recapEntryData({ text: "old" })),
			userEntry("a"),
			customEntry(RECAP_ENTRY_CUSTOM_TYPE, recapEntryData({ text: "new", source: "command" })),
		];
		const entry = readLastRecapEntry(branch);
		expect(entry?.text).toBe("new");
		expect(entry?.source).toBe("command");
	});

	it("ignores foreign custom types and malformed payloads", () => {
		const branch = [
			customEntry("model-profiles-state", { activeProfile: "work" }),
			customEntry(RECAP_ENTRY_CUSTOM_TYPE, { text: 42 }),
			customEntry(RECAP_ENTRY_CUSTOM_TYPE, "not an object"),
		];
		expect(readLastRecapEntry(branch)).toBeUndefined();
	});

	it("rejects entries missing the compaction counter (older/foreign shapes)", () => {
		const { compactionCount: _dropped, ...withoutCompactions } = recapEntryData();
		const branch = [customEntry(RECAP_ENTRY_CUSTOM_TYPE, withoutCompactions)];
		expect(readLastRecapEntry(branch)).toBeUndefined();
	});
});
