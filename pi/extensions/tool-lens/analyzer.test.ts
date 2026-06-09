import { describe, expect, it } from "bun:test";
import { Analyzer, type AnalyzerRunInput, type AnalyzerRunResult } from "./analyzer";
import { DEFAULT_TOOL_LENS_CONFIG } from "./config";
import { ToolLensStore } from "./store";
import type { ToolLensConfig, ToolLensPhase, ToolLensRecordV1 } from "./types";

function makeStore(): ToolLensStore {
	const store = new ToolLensStore();
	store.seed({ toolCallId: "a", turnIndex: 1, sourceOrder: 0, toolName: "bash", canonicalToolName: "bash", startedAt: 0 });
	return store;
}

const INTENT_TEXT = "## Intent\nrun tests\n## Why now\njust edited\n## Expected\ngreen\n## Watch\nflaky";
const OUTCOME_TEXT = "## Result\npassed\n## Matched intent\nyes done\n## Important details\n2 pass\n## Implication\nship";
const COMBINED_TEXT = `${INTENT_TEXT}\n${OUTCOME_TEXT}`;

interface Harness {
	analyzer: Analyzer;
	store: ToolLensStore;
	audits: Array<{ id: string; phase: ToolLensPhase }>;
	prompts: string[];
}

function makeAnalyzer(runner: (input: AnalyzerRunInput) => Promise<AnalyzerRunResult>, config: ToolLensConfig = DEFAULT_TOOL_LENS_CONFIG): Harness {
	const store = makeStore();
	const audits: Array<{ id: string; phase: ToolLensPhase }> = [];
	const prompts: string[] = [];
	const analyzer = new Analyzer(store, config, async (input) => {
		prompts.push(input.prompt);
		return runner(input);
	}, "system", {
		getMessages: () => [{ role: "user", content: "do the thing" }],
		onChange: () => {},
		onAudit: (record: ToolLensRecordV1, phase) => audits.push({ id: record.toolCallId, phase }),
	});
	return { analyzer, store, audits, prompts };
}

describe("Analyzer", () => {
	it("runs intent then outcome and marks done", async () => {
		const { analyzer, store, audits } = makeAnalyzer(async (input) =>
			({ status: "success", text: input.prompt.includes("OUTCOME") ? OUTCOME_TEXT : INTENT_TEXT }));

		analyzer.queueIntent("a");
		await analyzer.idle();
		expect(store.get("a")?.intent?.intent).toBe("run tests");

		analyzer.requestOutcome("a");
		await analyzer.idle();
		const record = store.get("a")!;
		expect(record.outcome?.matched).toBe("yes");
		expect(record.status).toBe("done");
		expect(audits.map((a) => a.phase)).toEqual(["intent", "outcome"]);
	});

	it("late-merges into a single combined call and records both phases", async () => {
		// Saturate a single analysis slot so tool b's intent stays queued, then end
		// b before its intent starts -> a single combined call (matches real flow).
		const store = new ToolLensStore();
		for (const id of ["a", "b"]) {
			store.seed({ toolCallId: id, turnIndex: 1, sourceOrder: id === "a" ? 0 : 1, toolName: "bash", canonicalToolName: "bash", startedAt: 0 });
		}
		const audits: Array<{ id: string; phase: ToolLensPhase }> = [];
		const prompts: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const config: ToolLensConfig = { ...DEFAULT_TOOL_LENS_CONFIG, analysis: { ...DEFAULT_TOOL_LENS_CONFIG.analysis, maxConcurrentAnalyses: 1 } };
		const analyzer = new Analyzer(store, config, async (input) => {
			prompts.push(input.prompt);
			if (prompts.length === 1) await gate; // hold the slot on a's intent
			return { status: "success", text: input.prompt.includes("BOTH") ? COMBINED_TEXT : INTENT_TEXT };
		}, "system", {
			getMessages: () => [],
			onChange: () => {},
			onAudit: (record, phase) => audits.push({ id: record.toolCallId, phase }),
		});

		analyzer.queueIntent("a"); // launches, holds the slot
		analyzer.queueIntent("b"); // queued behind a
		analyzer.requestOutcome("b"); // b's intent still queued -> combine
		await Promise.resolve();
		release();
		await analyzer.idle();

		const bPrompts = prompts.filter((p) => p.includes("BOTH"));
		expect(bPrompts).toHaveLength(1);
		expect(store.get("b")?.intent?.intent).toBe("run tests");
		expect(store.get("b")?.outcome?.result).toBe("passed");
		expect(audits.filter((a) => a.id === "b").map((a) => a.phase)).toEqual(["intent", "outcome"]);
	});

	it("preserves intent when the outcome call errors", async () => {
		let call = 0;
		const { analyzer, store } = makeAnalyzer(async (): Promise<AnalyzerRunResult> => {
			call += 1;
			return call === 1 ? { status: "success", text: INTENT_TEXT } : { status: "error", text: "", message: "timeout" };
		});
		analyzer.queueIntent("a");
		await analyzer.idle();
		analyzer.requestOutcome("a");
		await analyzer.idle();
		const record = store.get("a")!;
		expect(record.intent?.intent).toBe("run tests");
		expect(record.outcome).toBeUndefined();
		expect(record.errors).toContain("timeout");
		// Intent survived, so status is not error.
		expect(record.status).not.toBe("error");
	});

	it("marks error when the first analysis fails with nothing captured", async () => {
		const { analyzer, store } = makeAnalyzer(async () => ({ status: "error", text: "", message: "boom" }));
		analyzer.queueIntent("a");
		await analyzer.idle();
		expect(store.get("a")?.status).toBe("error");
	});

	it("honors intent-only and outcome-only modes", async () => {
		const intentOnly = makeAnalyzer(async () => ({ status: "success", text: INTENT_TEXT }), { ...DEFAULT_TOOL_LENS_CONFIG, mode: "intent-only" });
		intentOnly.analyzer.queueIntent("a");
		intentOnly.analyzer.requestOutcome("a"); // ignored
		await intentOnly.analyzer.idle();
		expect(intentOnly.prompts).toHaveLength(1);

		const outcomeOnly = makeAnalyzer(async () => ({ status: "success", text: OUTCOME_TEXT }), { ...DEFAULT_TOOL_LENS_CONFIG, mode: "outcome-only" });
		outcomeOnly.analyzer.queueIntent("a"); // ignored
		outcomeOnly.analyzer.requestOutcome("a");
		await outcomeOnly.analyzer.idle();
		expect(outcomeOnly.prompts).toHaveLength(1);
		expect(outcomeOnly.store.get("a")?.outcome?.result).toBe("passed");
	});

	it("marks not_analyzed when over the per-turn budget", async () => {
		const store = new ToolLensStore();
		for (const id of ["a", "b", "c"]) {
			store.seed({ toolCallId: id, turnIndex: 1, sourceOrder: 0, toolName: "bash", canonicalToolName: "bash", startedAt: 0 });
		}
		const config: ToolLensConfig = { ...DEFAULT_TOOL_LENS_CONFIG, limits: { ...DEFAULT_TOOL_LENS_CONFIG.limits, maxAnalysesPerTurn: 1 } };
		const analyzer = new Analyzer(store, config, async () => ({ status: "success", text: INTENT_TEXT }), "system", {
			getMessages: () => [],
			onChange: () => {},
			onAudit: () => {},
		});
		analyzer.queueIntent("a");
		analyzer.queueIntent("b");
		analyzer.queueIntent("c");
		await analyzer.idle();
		const skipped = ["a", "b", "c"].filter((id) => store.get(id)?.status === "not_analyzed");
		expect(skipped.length).toBe(2);
	});
});
