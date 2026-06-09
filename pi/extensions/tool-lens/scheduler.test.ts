import { describe, expect, it } from "bun:test";
import { AnalysisScheduler, type AnalysisTask } from "./scheduler";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function defer(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe("AnalysisScheduler", () => {
	it("respects the concurrency limit", async () => {
		const gates: Deferred[] = [];
		let peak = 0;
		let active = 0;
		const scheduler = new AnalysisScheduler({
			concurrency: 2,
			maxAnalysesPerTurn: 24,
			lateMerge: false,
			run: async () => {
				active += 1;
				peak = Math.max(peak, active);
				const gate = defer();
				gates.push(gate);
				await gate.promise;
				active -= 1;
			},
		});

		for (const id of ["a", "b", "c", "d"]) scheduler.queueIntent(id);
		await Promise.resolve();
		expect(scheduler.inFlightCount).toBe(2);
		expect(peak).toBe(2);

		// Drain in waves.
		while (gates.length > 0) {
			gates.shift()!.resolve();
			await new Promise((r) => setTimeout(r, 0));
		}
		await scheduler.idle();
		expect(peak).toBe(2);
	});

	it("late-merges an outcome into a queued intent as a single combined call", async () => {
		const ran: AnalysisTask[] = [];
		const scheduler = new AnalysisScheduler({
			concurrency: 1,
			maxAnalysesPerTurn: 24,
			lateMerge: true,
			run: async (task) => {
				ran.push(task);
			},
		});

		// Saturate the single slot so b's intent stays queued.
		scheduler.queueIntent("a");
		scheduler.queueIntent("b");
		// b ends before its intent starts -> combine.
		scheduler.requestOutcome("b");
		await scheduler.idle();

		const bTasks = ran.filter((t) => t.toolCallId === "b");
		expect(bTasks).toHaveLength(1);
		expect(bTasks[0]!.kind).toBe("combined");
	});

	it("runs a separate outcome when the intent already started", async () => {
		const ran: AnalysisTask[] = [];
		const gate = defer();
		let firstStarted = false;
		const scheduler = new AnalysisScheduler({
			concurrency: 2,
			maxAnalysesPerTurn: 24,
			lateMerge: true,
			run: async (task) => {
				ran.push(task);
				if (task.kind === "intent" && task.toolCallId === "a" && !firstStarted) {
					firstStarted = true;
					await gate.promise;
				}
			},
		});

		scheduler.queueIntent("a");
		await Promise.resolve();
		// a's intent is now running; outcome should be separate, not combined.
		scheduler.requestOutcome("a");
		await new Promise((r) => setTimeout(r, 0));
		gate.resolve();
		await scheduler.idle();

		const kinds = ran.filter((t) => t.toolCallId === "a").map((t) => t.kind).sort();
		expect(kinds).toEqual(["intent", "outcome"]);
	});

	it("skips over-budget tasks instead of queueing unboundedly", async () => {
		const ran: AnalysisTask[] = [];
		const skipped: AnalysisTask[] = [];
		const scheduler = new AnalysisScheduler({
			concurrency: 4,
			maxAnalysesPerTurn: 2,
			lateMerge: false,
			run: async (task) => {
				ran.push(task);
			},
			onSkip: (task, reason) => {
				if (reason === "budget") skipped.push(task);
			},
		});

		for (const id of ["a", "b", "c", "d"]) scheduler.queueIntent(id);
		await scheduler.idle();
		expect(ran).toHaveLength(2);
		expect(skipped).toHaveLength(2);
		expect(scheduler.launchedCount).toBe(2);
	});

	it("aborts queued work and reports skips", async () => {
		const skipped: AnalysisTask[] = [];
		const gate = defer();
		const scheduler = new AnalysisScheduler({
			concurrency: 1,
			maxAnalysesPerTurn: 24,
			lateMerge: false,
			run: async () => {
				await gate.promise;
			},
			onSkip: (task, reason) => {
				if (reason === "aborted") skipped.push(task);
			},
		});

		scheduler.queueIntent("a");
		scheduler.queueIntent("b");
		await Promise.resolve();
		scheduler.abort();
		gate.resolve();
		await scheduler.idle();
		expect(skipped.map((t) => t.toolCallId)).toEqual(["b"]);
	});
});
