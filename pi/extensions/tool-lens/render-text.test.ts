import { describe, expect, it } from "bun:test";
import { cardLines, hudCompactLine, hudLines, hudRow } from "./render-text";
import { TOOL_LENS_ANALYSIS_SCHEMA, type ToolLensRecordV1, type ToolLensStatus } from "./types";

function record(partial: Partial<ToolLensRecordV1> & { toolCallId: string }): ToolLensRecordV1 {
	return {
		schema: TOOL_LENS_ANALYSIS_SCHEMA,
		turnIndex: 1,
		sourceOrder: 0,
		toolName: "bash",
		canonicalToolName: "bash",
		startedAt: 0,
		status: "observed" as ToolLensStatus,
		...partial,
	};
}

describe("hud rendering", () => {
	it("renders one labelled row per tool call with status", () => {
		const row = hudRow(record({ toolCallId: "a", toolName: "read", canonicalToolName: "read", status: "executing", intent: { intent: "inspect readme" } }), 0);
		expect(row).toContain("A");
		expect(row).toContain("read");
		expect(row).toContain("running");
		expect(row).toContain("inspect readme");
	});

	it("renders a header and overflow indicator", () => {
		const records = Array.from({ length: 5 }, (_, i) => record({ toolCallId: `t${i}`, sourceOrder: i }));
		const lines = hudLines(records, 7, 3);
		expect(lines[0]).toBe("tool-lens · turn 7");
		expect(lines).toContain("… +2 more");
		expect(lines.length).toBe(1 + 3 + 1);
	});

	it("shows a waiting state when empty", () => {
		expect(hudLines([], 2, 8)).toEqual(["tool-lens · turn 2", "(waiting for tool calls)"]);
	});

	it("summarizes a batch on one line", () => {
		const records = [
			record({ toolCallId: "a", status: "done", outcome: { result: "ok", matched: "yes" } }),
			record({ toolCallId: "b", status: "error", errors: ["boom"] }),
			record({ toolCallId: "c", status: "executing" }),
		];
		const line = hudCompactLine(records);
		expect(line).toContain("3 calls");
		expect(line).toContain("1 analyzed");
		expect(line).toContain("1 active");
		expect(line).toContain("1 errors");
	});
});

describe("card rendering", () => {
	const full = record({
		toolCallId: "a",
		status: "done",
		intent: { intent: "verify config parser", whyNow: "parser just edited", expected: "pass", watch: "flaky" },
		outcome: { result: "passed", matched: "yes", importantDetails: "2 pass", implication: "ship" },
	});

	it("hidden renders a single stub line", () => {
		expect(cardLines(full, "hidden", true)).toEqual(["lens bash (hidden)"]);
	});

	it("compact renders one summary line", () => {
		const lines = cardLines(full, "compact", false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("verify config parser");
		expect(lines[0]).toContain("matched");
	});

	it("full collapsed shows title plus summary; expanded shows all fields", () => {
		const collapsed = cardLines(full, "full", false);
		expect(collapsed.length).toBe(2);
		const expanded = cardLines(full, "full", true);
		expect(expanded.join("\n")).toContain("intent: verify config parser");
		expect(expanded.join("\n")).toContain("implication: ship");
		expect(expanded.join("\n")).toContain("outcome: passed (matched)");
	});

	it("renders a not-analyzed reason", () => {
		const skipped = record({ toolCallId: "b", status: "not_analyzed", errors: ["redaction failed"] });
		expect(cardLines(skipped, "full", true).join("\n")).toContain("not analyzed: redaction failed");
		expect(cardLines(skipped, "compact", false)[0]).toContain("not analyzed: redaction failed");
	});
});
