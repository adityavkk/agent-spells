/**
 * Analysis scheduler: one global FIFO semaphore across a tool batch, with
 * late-merge and a per-turn budget.
 *
 * Verified event ordering (executeToolCallsParallel): all `tool_execution_start`
 * fire upfront in source order, then `tool_execution_end` fire in completion
 * order. So we fan out intents at start and request outcomes at end:
 *
 *   - `queueIntent` enqueues a standalone intent analysis.
 *   - `requestOutcome` enqueues an outcome analysis, unless the tool's intent
 *     is still queued (not started) and late-merge is on, in which case the
 *     queued intent is replaced by a single combined intent+outcome call.
 *
 * Concurrency is bounded by `concurrency`; total model launches per turn are
 * bounded by `maxAnalysesPerTurn` (over-budget tasks are skipped, not queued
 * unboundedly). The actual model work is injected via `run`, keeping this module
 * deterministic and testable.
 */

export type AnalysisKind = "intent" | "outcome" | "combined";

export interface AnalysisTask {
	toolCallId: string;
	kind: AnalysisKind;
}

export type AnalysisSkipReason = "budget" | "aborted";

export interface AnalysisSchedulerOptions {
	concurrency: number;
	maxAnalysesPerTurn: number;
	lateMerge: boolean;
	run: (task: AnalysisTask, signal: AbortSignal) => Promise<void>;
	onSkip?: (task: AnalysisTask, reason: AnalysisSkipReason) => void;
}

type IntentStatus = "queued" | "running" | "settled";

export class AnalysisScheduler {
	private readonly queue: AnalysisTask[] = [];
	private readonly intentStatus = new Map<string, IntentStatus>();
	private readonly controller = new AbortController();
	private inFlight = 0;
	private launched = 0;
	private aborted = false;
	private idleWaiters: Array<() => void> = [];

	constructor(private readonly options: AnalysisSchedulerOptions) {}

	/** Reset the per-turn launch budget at the start of a new turn/batch. */
	resetTurn(): void {
		this.launched = 0;
	}

	queueIntent(toolCallId: string): void {
		if (this.aborted) return;
		this.intentStatus.set(toolCallId, "queued");
		this.queue.push({ toolCallId, kind: "intent" });
		this.pump();
	}

	requestOutcome(toolCallId: string): void {
		if (this.aborted) return;
		if (this.options.lateMerge && this.intentStatus.get(toolCallId) === "queued") {
			this.removeQueuedIntent(toolCallId);
			this.intentStatus.set(toolCallId, "queued");
			this.queue.push({ toolCallId, kind: "combined" });
		} else {
			this.queue.push({ toolCallId, kind: "outcome" });
		}
		this.pump();
	}

	private removeQueuedIntent(toolCallId: string): void {
		const index = this.queue.findIndex((task) => task.toolCallId === toolCallId && task.kind === "intent");
		if (index >= 0) this.queue.splice(index, 1);
	}

	private settleIntent(task: AnalysisTask): void {
		if (task.kind === "intent" || task.kind === "combined") {
			this.intentStatus.set(task.toolCallId, "settled");
		}
	}

	private pump(): void {
		while (!this.aborted && this.inFlight < this.options.concurrency && this.queue.length > 0) {
			const task = this.queue.shift()!;
			this.launch(task);
		}
		this.maybeResolveIdle();
	}

	private launch(task: AnalysisTask): void {
		if (this.launched >= this.options.maxAnalysesPerTurn) {
			this.settleIntent(task);
			this.options.onSkip?.(task, "budget");
			return;
		}
		this.launched += 1;
		if (task.kind === "intent" || task.kind === "combined") {
			this.intentStatus.set(task.toolCallId, "running");
		}
		this.inFlight += 1;
		Promise.resolve()
			.then(() => this.options.run(task, this.controller.signal))
			.catch(() => {
				// `run` is responsible for recording its own errors; never throw here.
			})
			.finally(() => {
				this.inFlight -= 1;
				this.settleIntent(task);
				this.pump();
			});
	}

	/** Resolves once the queue is drained and nothing is in flight. */
	idle(): Promise<void> {
		if (this.isQuiescent()) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private isQuiescent(): boolean {
		return this.queue.length === 0 && this.inFlight === 0;
	}

	private maybeResolveIdle(): void {
		if (!this.isQuiescent()) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** Stop scheduling, drop queued work, and abort in-flight model streams. */
	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		const dropped = this.queue.splice(0, this.queue.length);
		for (const task of dropped) this.options.onSkip?.(task, "aborted");
		this.controller.abort();
		this.maybeResolveIdle();
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	get inFlightCount(): number {
		return this.inFlight;
	}

	get launchedCount(): number {
		return this.launched;
	}
}
