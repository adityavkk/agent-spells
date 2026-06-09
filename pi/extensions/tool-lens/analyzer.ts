/**
 * Analyzer orchestration: turns scheduler tasks into model calls, parses the
 * Markdown response into intent/outcome, and writes results back to the store.
 *
 * The actual model invocation is injected as `AnalyzerRunner` so this module is
 * deterministic and unit-testable; the real pi-ai streaming glue lives in
 * `model-runner.ts`. Timeouts and aborts are handled here so a slow or failed
 * analysis never blocks or mutates the main tool call.
 */
import type { BuiltContext } from "./context";
import { buildConversationContext, type ConversationMessageLike } from "./context";
import { buildPrompt, parseIntentResponse, parseOutcomeResponse, type PromptKind } from "./prompts";
import { AnalysisScheduler, type AnalysisTask } from "./scheduler";
import { advanceStatus, ToolLensStore } from "./store";
import type { ToolLensConfig, ToolLensPhase, ToolLensRecordV1 } from "./types";

export interface AnalyzerRunInput {
	systemPrompt: string;
	prompt: string;
	timeoutMs: number;
	signal: AbortSignal;
	onDelta?: (text: string) => void;
}

export interface AnalyzerRunResult {
	status: "success" | "error" | "aborted";
	text: string;
	message?: string;
}

export type AnalyzerRunner = (input: AnalyzerRunInput) => Promise<AnalyzerRunResult>;

export interface AnalyzerCallbacks {
	/** Snapshot of recent conversation messages for context, taken lazily per task. */
	getMessages: () => ConversationMessageLike[];
	/** Repaint hook fired on any record change (HUD/status). */
	onChange: (record: ToolLensRecordV1) => void;
	/** Append a per-phase audit entry. */
	onAudit: (record: ToolLensRecordV1, phase: ToolLensPhase) => void;
}

export class Analyzer {
	readonly scheduler: AnalysisScheduler;

	constructor(
		private readonly store: ToolLensStore,
		private readonly config: ToolLensConfig,
		private readonly runner: AnalyzerRunner,
		private readonly systemPrompt: string,
		private readonly callbacks: AnalyzerCallbacks,
	) {
		this.scheduler = new AnalysisScheduler({
			concurrency: Math.max(1, config.analysis.maxConcurrentAnalyses),
			maxAnalysesPerTurn: config.limits.maxAnalysesPerTurn,
			lateMerge: config.analysis.lateMerge,
			run: (task, signal) => this.runTask(task, signal),
			onSkip: (task, reason) => this.onSkip(task, reason),
		});
	}

	resetTurn(): void {
		this.scheduler.resetTurn();
	}

	queueIntent(toolCallId: string): void {
		if (this.config.mode === "outcome-only") return;
		this.scheduler.queueIntent(toolCallId);
	}

	requestOutcome(toolCallId: string): void {
		if (this.config.mode === "intent-only") {
			return;
		}
		this.scheduler.requestOutcome(toolCallId);
	}

	idle(): Promise<void> {
		return this.scheduler.idle();
	}

	abort(): void {
		this.scheduler.abort();
	}

	private buildContext(): BuiltContext {
		return buildConversationContext(this.callbacks.getMessages(), this.config);
	}

	private onSkip(task: AnalysisTask, reason: "budget" | "aborted"): void {
		const record = this.store.get(task.toolCallId);
		if (!record) return;
		if (reason === "budget") {
			this.store.appendError(task.toolCallId, "batch over budget");
			this.store.setStatus(task.toolCallId, "not_analyzed");
			this.callbacks.onChange(this.store.get(task.toolCallId)!);
		}
		// Aborted tasks are left as-is; session_shutdown clears UI.
	}

	private async runTask(task: AnalysisTask, signal: AbortSignal): Promise<void> {
		const record = this.store.get(task.toolCallId);
		if (!record || record.status === "not_analyzed") return;

		const kinds: PromptKind[] = task.kind === "combined" ? ["combined"] : [task.kind];
		const kind = kinds[0]!;
		advanceStatus(this.store, task.toolCallId, kind === "outcome" ? "outcome_streaming" : "intent_streaming");
		this.emit(task.toolCallId);

		const context = this.buildContext();
		const current = this.store.get(task.toolCallId)!;
		const prompt = buildPrompt(kind, current, context);
		const result = await this.runner({
			systemPrompt: this.systemPrompt,
			prompt,
			timeoutMs: this.config.analysis.timeoutMs,
			signal,
		});

		if (result.status === "aborted") return;
		if (result.status === "error") {
			this.store.appendError(task.toolCallId, result.message ?? "analyzer error");
			// Preserve any intent already captured; only flag error if nothing useful.
			const after = this.store.get(task.toolCallId)!;
			if (!after.intent && !after.outcome) this.store.setStatus(task.toolCallId, "error");
			this.emit(task.toolCallId);
			return;
		}

		this.applyResponse(task.toolCallId, kind, result.text);
	}

	private applyResponse(toolCallId: string, kind: PromptKind, text: string): void {
		if (kind === "intent" || kind === "combined") {
			const intent = parseIntentResponse(text);
			if (intent) {
				this.store.setIntent(toolCallId, intent);
				this.audit(toolCallId, "intent");
			}
		}
		if (kind === "outcome" || kind === "combined") {
			const outcome = parseOutcomeResponse(text);
			if (outcome) {
				this.store.setOutcome(toolCallId, outcome);
				this.audit(toolCallId, "outcome");
			}
		}
		const record = this.store.get(toolCallId)!;
		// Mark done when outcome exists, or when an intent-only run finished and
		// the tool has already ended (status was executing).
		if (record.outcome) advanceStatus(this.store, toolCallId, "done");
		this.emit(toolCallId);
	}

	private audit(toolCallId: string, phase: ToolLensPhase): void {
		const record = this.store.get(toolCallId);
		if (record) this.callbacks.onAudit(record, phase);
	}

	private emit(toolCallId: string): void {
		const record = this.store.get(toolCallId);
		if (record) this.callbacks.onChange(record);
	}
}
