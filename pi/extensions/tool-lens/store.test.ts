import { describe, expect, it } from "bun:test";
import { normalizeRecord } from "./normalize";
import {
	type BranchEntryLike,
	buildAuditPayload,
	buildCardDetails,
	reconstructFromBranch,
	ToolLensStore,
} from "./store";
import {
	TOOL_LENS_ANALYSIS_SCHEMA,
	TOOL_LENS_AUDIT_CUSTOM_TYPE,
	TOOL_LENS_CARD_CUSTOM_TYPE,
	type ToolLensRecordV1,
} from "./types";

function seedStore(): ToolLensStore {
	const store = new ToolLensStore();
	store.seed({ toolCallId: "a", turnIndex: 1, sourceOrder: 0, toolName: "read", canonicalToolName: "read", startedAt: 10 });
	store.seed({ toolCallId: "b", turnIndex: 1, sourceOrder: 1, toolName: "shell_command", canonicalToolName: "bash", startedAt: 11 });
	return store;
}

describe("ToolLensStore", () => {
	it("seeds idempotently and updates phases", () => {
		const store = seedStore();
		expect(store.size).toBe(2);
		store.seed({ toolCallId: "a", turnIndex: 1, sourceOrder: 0, toolName: "read", canonicalToolName: "read", startedAt: 99 });
		expect(store.get("a")?.startedAt).toBe(10); // not overwritten

		store.setIntent("a", { intent: "inspect readme" });
		store.setStatus("a", "intent_streaming");
		expect(store.get("a")?.intent?.intent).toBe("inspect readme");
		expect(store.get("a")?.status).toBe("intent_streaming");

		store.setOutcome("a", { result: "read 40 lines", matched: "yes" });
		expect(store.get("a")?.outcome?.matched).toBe("yes");
	});

	it("accumulates errors and preserves identity on update", () => {
		const store = seedStore();
		store.appendError("b", "timeout");
		store.appendError("b", "retry failed");
		expect(store.get("b")?.errors).toEqual(["timeout", "retry failed"]);
		const updated = store.update("b", { toolCallId: "hacked" as never, status: "error" });
		expect(updated?.toolCallId).toBe("b");
	});

	it("returns records in source order regardless of completion order", () => {
		const store = seedStore();
		// b completes before a, but display order stays source order (a then b).
		store.setStatus("b", "done");
		store.setStatus("a", "done");
		expect(store.allSourceOrdered().map((r) => r.toolCallId)).toEqual(["a", "b"]);
	});
});

describe("audit and card payloads", () => {
	it("buildAuditPayload sets phase; buildCardDetails omits it", () => {
		const store = seedStore();
		store.setIntent("a", { intent: "inspect" });
		const record = store.get("a")!;
		const audit = buildAuditPayload(record, "intent");
		expect(audit.phase).toBe("intent");
		const card = buildCardDetails(audit);
		expect(card.record.phase).toBeUndefined();
		expect(card.record.intent?.intent).toBe("inspect");
	});
});

describe("reconstructFromBranch", () => {
	const baseRecord = (id: string, sourceOrder: number): ToolLensRecordV1 => ({
		schema: TOOL_LENS_ANALYSIS_SCHEMA,
		toolCallId: id,
		turnIndex: 1,
		sourceOrder,
		toolName: "read",
		startedAt: sourceOrder,
		status: "done",
	});

	it("prefers card details over audit phases for the same tool call", () => {
		const branch: BranchEntryLike[] = [
			{ type: "custom", customType: TOOL_LENS_AUDIT_CUSTOM_TYPE, data: { ...baseRecord("a", 0), phase: "intent", intent: { intent: "stale" } } },
			{
				type: "message",
				message: {
					role: "custom",
					customType: TOOL_LENS_CARD_CUSTOM_TYPE,
					details: buildCardDetails({ ...baseRecord("a", 0), intent: { intent: "final" }, outcome: { result: "ok", matched: "yes" } }),
				},
			},
		];
		const records = reconstructFromBranch(branch);
		expect(records).toHaveLength(1);
		expect(records[0]!.intent?.intent).toBe("final");
		expect(records[0]!.outcome?.result).toBe("ok");
	});

	it("falls back to the latest audit phase when no card exists", () => {
		const branch: BranchEntryLike[] = [
			{ type: "custom", customType: TOOL_LENS_AUDIT_CUSTOM_TYPE, data: { ...baseRecord("b", 1), phase: "intent", intent: { intent: "i" } } },
			{ type: "custom", customType: TOOL_LENS_AUDIT_CUSTOM_TYPE, data: { ...baseRecord("b", 1), phase: "outcome", intent: { intent: "i" }, outcome: { result: "done", matched: "partial" } } },
		];
		const records = reconstructFromBranch(branch);
		expect(records).toHaveLength(1);
		expect(records[0]!.outcome?.matched).toBe("partial");
	});

	it("orders reconstructed records by source order and ignores foreign entries", () => {
		const branch: BranchEntryLike[] = [
			{ type: "message", message: { role: "custom", customType: TOOL_LENS_CARD_CUSTOM_TYPE, details: buildCardDetails(baseRecord("b", 1)) } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "custom", customType: "other-extension", data: { toolCallId: "x" } },
			{ type: "message", message: { role: "custom", customType: TOOL_LENS_CARD_CUSTOM_TYPE, details: buildCardDetails(baseRecord("a", 0)) } },
		];
		const records = reconstructFromBranch(branch);
		expect(records.map((r) => r.toolCallId)).toEqual(["a", "b"]);
	});
});

describe("normalizeRecord", () => {
	it("returns null without a toolCallId", () => {
		expect(normalizeRecord({})).toBeNull();
		expect(normalizeRecord(null)).toBeNull();
	});

	it("fills defaults and drops unknown fields", () => {
		const record = normalizeRecord({ toolCallId: "z", bogus: true, status: "weird", outcome: { result: "x", matched: "maybe" } });
		expect(record?.toolName).toBe("unknown");
		expect(record?.status).toBe("observed");
		expect(record?.outcome?.matched).toBe("unknown");
		expect((record as Record<string, unknown>).bogus).toBeUndefined();
	});
});
