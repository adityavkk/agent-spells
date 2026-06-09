import { describe, expect, it } from "bun:test";
import { flushCards, isFlushable, type CardSink } from "./flush";
import { ToolLensStore } from "./store";
import { TOOL_LENS_CARD_CUSTOM_TYPE, type ToolLensCardDetails } from "./types";

function makeSink(): CardSink & { sent: Array<{ customType: string; content: string; details: ToolLensCardDetails }> } {
	const sent: Array<{ customType: string; content: string; details: ToolLensCardDetails }> = [];
	return { sent, send: (message) => sent.push(message) };
}

function storeWithAnalyzed(): ToolLensStore {
	const store = new ToolLensStore();
	store.seed({ toolCallId: "a", turnIndex: 1, sourceOrder: 0, toolName: "read", canonicalToolName: "read", startedAt: 0 });
	store.seed({ toolCallId: "b", turnIndex: 1, sourceOrder: 1, toolName: "bash", canonicalToolName: "bash", startedAt: 1 });
	store.setIntent("a", { intent: "inspect" });
	store.setOutcome("b", { result: "ran", matched: "yes" });
	return store;
}

describe("isFlushable", () => {
	it("is true with intent or outcome, and for terminal not_analyzed/error", () => {
		const store = storeWithAnalyzed();
		expect(isFlushable(store.get("a")!)).toBe(true);
		store.seed({ toolCallId: "c", turnIndex: 1, sourceOrder: 2, toolName: "ls", canonicalToolName: "ls", startedAt: 2 });
		expect(isFlushable(store.get("c")!)).toBe(false);
		store.setStatus("c", "not_analyzed");
		expect(isFlushable(store.get("c")!)).toBe(true);
	});
});

describe("flushCards", () => {
	it("flushes one card per analyzed call in source order with empty content", () => {
		const store = storeWithAnalyzed();
		const sink = makeSink();
		const flushed = new Set<string>();
		const ids = flushCards({ store, flushed, sink, isIdle: () => true, persistCards: true });
		expect(ids).toEqual(["a", "b"]);
		expect(sink.sent).toHaveLength(2);
		expect(sink.sent[0]!.customType).toBe(TOOL_LENS_CARD_CUSTOM_TYPE);
		expect(sink.sent[0]!.content).toBe("");
		expect(sink.sent[0]!.details.record.toolCallId).toBe("a");
		expect(sink.sent[0]!.details.record.phase).toBeUndefined();
	});

	it("does not double-flush already-flushed calls", () => {
		const store = storeWithAnalyzed();
		const sink = makeSink();
		const flushed = new Set<string>(["a"]);
		const ids = flushCards({ store, flushed, sink, isIdle: () => true, persistCards: true });
		expect(ids).toEqual(["b"]);
		expect(sink.sent).toHaveLength(1);
	});

	it("no-ops when not idle or cards disabled", () => {
		const store = storeWithAnalyzed();
		const sink = makeSink();
		expect(flushCards({ store, flushed: new Set(), sink, isIdle: () => false, persistCards: true })).toEqual([]);
		expect(flushCards({ store, flushed: new Set(), sink, isIdle: () => true, persistCards: false })).toEqual([]);
		expect(sink.sent).toHaveLength(0);
	});
});
