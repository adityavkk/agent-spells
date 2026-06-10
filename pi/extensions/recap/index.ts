/**
 * recap: a "here's where we left off" summary above the editor.
 *
 * Modeled on Claude Code's Session recap (see ideas/recap/recap-widget.md):
 *   - Automatic: generated in the background on the focus+idle edge
 *     (>= idleThresholdMs since the last completed turn while the terminal is
 *     unfocused), displayed the moment focus returns. Gated on >= minTurns,
 *     never-twice-in-a-row, and never while composing unsent text.
 *   - On demand: /recap generates and shows immediately, bypassing all gates.
 *
 * Display-only by design: the recap never touches conversation history or
 * compaction. Persistence goes through pi.appendEntry (not LLM-visible).
 * Generation runs on a cheap model resolved through model-profiles (roles
 * ["recap", "smol", "small"]). Every automatic-path failure is silent.
 *
 * Staleness is handled with an epoch counter: compaction and tree navigation
 * bump it (and abort any in-flight generation), and results from an older
 * epoch are discarded instead of committed.
 */
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { loadModelProfilesConfig } from "../model-profiles/config";
import { readModelProfilesState } from "../model-profiles/resolve";
import type { ModelProfilesState } from "../model-profiles/types";
import { isRecapAutoEnabled, loadRecapConfig } from "./config";
import {
	DISABLE_FOCUS_REPORTING,
	ENABLE_FOCUS_REPORTING,
	isBracketedPaste,
	parseFocusEvents,
} from "./focus";
import { parseSyntheticProfileSelection, resolveRecapModel } from "./model-selection";
import {
	buildRecapContext,
	describeResolvedModel,
	runRecapCompletion,
} from "./summarize";
import {
	buildRecapDigest,
	computeTranscriptFingerprint,
	countCompactions,
	countCompletedTurns,
	readLastRecapEntry,
} from "./transcript";
import {
	createTriggerState,
	deferShowToFocusIn,
	effectiveTriggerMode,
	invalidateCache,
	msUntilIdleThreshold,
	onActivity,
	onFocusChange,
	onGenerated,
	onShown,
	onTurnEnd,
	reseedTurns,
	shouldGenerate,
	shouldShow,
	type TriggerGateOptions,
} from "./trigger";
import {
	RECAP_DISABLE_FLAG,
	RECAP_ENTRY_CUSTOM_TYPE,
	RECAP_WIDGET_KEY,
	type RecapConfig,
	type RecapEntryData,
	type TriggerEnvironment,
	type TriggerState,
} from "./types";
import {
	createRecapWidgetComponent,
	formatContextGauge,
	type RecapWidgetView,
} from "./widget";

/** Delta-summarization base: the previous recap and how much it covered. */
interface DeltaBase {
	text: string;
	messageCount: number;
	compactionCount: number;
}

/** Mutable per-session runtime; rebuilt on every session_start. */
interface RecapRuntime {
	config: RecapConfig;
	autoEnabled: boolean;
	state: TriggerState;
	deltaBase: DeltaBase | null;
	timer: ReturnType<typeof setTimeout> | null;
	unsubscribeInput: (() => void) | null;
	focusReportingEnabled: boolean;
	generationInFlight: boolean;
	generationAbort: AbortController | null;
	/** Bumped by compaction/tree navigation; in-flight results from an older epoch are discarded. */
	epoch: number;
	widgetView: RecapWidgetView | null;
	widgetMounted: boolean;
	tui: TUI | null;
}

function gateOptions(config: RecapConfig): TriggerGateOptions {
	return {
		idleThresholdMs: config.idleThresholdMs,
		minTurns: config.minTurns,
		neverTwiceInARow: config.neverTwiceInARow,
		trigger: config.trigger,
	};
}

/** turn_end fires per assistant round and for aborted turns; only normal stops count. */
function isCompletedAssistantTurn(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; stopReason?: unknown };
	return m.role === "assistant" && m.stopReason === "stop";
}

function writeToTerminal(sequence: string): boolean {
	try {
		process.stdout.write(sequence);
		return true;
	} catch {
		return false;
	}
}

export default function recapExtension(pi: ExtensionAPI) {
	// The command name must be known at registration time; everything else is
	// (re)loaded with the session cwd on session_start.
	const startupConfig = loadRecapConfig(process.cwd()).mergedConfig;
	const registeredCommandName = startupConfig.commandName;

	let runtime: RecapRuntime | null = null;
	let lastCtx: ExtensionContext | null = null;
	let exitRestoreInstalled = false;

	pi.registerFlag(RECAP_DISABLE_FLAG, {
		description: "Disable the automatic session recap for this run",
		type: "boolean",
	});

	/**
	 * Last-resort terminal restore: covers uncaught exceptions and
	 * process.exit paths where session_shutdown never fires. Synchronous
	 * stdout writes are safe in exit handlers for TTYs.
	 */
	function installExitRestore(): void {
		if (exitRestoreInstalled) return;
		exitRestoreInstalled = true;
		process.on("exit", () => {
			if (runtime?.focusReportingEnabled) writeToTerminal(DISABLE_FOCUS_REPORTING);
		});
	}

	// ---- environment snapshots -------------------------------------------

	function triggerEnvironment(ctx: ExtensionContext, rt: RecapRuntime): TriggerEnvironment {
		const editorEmpty = rt.config.suppressWhileComposing ? ctx.ui.getEditorText().trim().length === 0 : true;
		return {
			editorEmpty,
			agentIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			fingerprint: computeTranscriptFingerprint(ctx.sessionManager.getBranch()),
		};
	}

	// ---- widget ------------------------------------------------------------

	function showWidget(ctx: ExtensionContext, rt: RecapRuntime, view: RecapWidgetView): void {
		rt.widgetView = view;
		if (!rt.widgetMounted) {
			rt.widgetMounted = true;
			try {
				ctx.ui.setWidget(
					RECAP_WIDGET_KEY,
					(tui, theme) => {
						rt.tui = tui;
						return createRecapWidgetComponent(() => rt.widgetView ?? view, theme);
					},
					{ placement: "aboveEditor" },
				);
			} catch {
				rt.widgetMounted = false;
				rt.widgetView = null;
			}
		} else {
			rt.tui?.requestRender();
		}
	}

	function clearWidget(ctx: ExtensionContext, rt: RecapRuntime): void {
		if (!rt.widgetMounted) return;
		rt.widgetMounted = false;
		rt.widgetView = null;
		rt.tui = null;
		try {
			ctx.ui.setWidget(RECAP_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		} catch {
			// Clearing during teardown must never throw.
		}
	}

	function recapView(ctx: ExtensionContext, rt: RecapRuntime, text: string): RecapWidgetView {
		const gauge = rt.config.showContextGauge ? formatContextGauge(ctx.getContextUsage()?.percent) : undefined;
		return {
			text,
			maxLines: rt.config.maxLines,
			style: rt.config.style,
			contextGauge: gauge,
		};
	}

	// ---- generation --------------------------------------------------------

	/** Live model-profiles selection: a synthetic profiles/<p:r> model wins over persisted state. */
	function effectiveProfilesState(ctx: ExtensionContext): ModelProfilesState {
		const persisted = readModelProfilesState(ctx.sessionManager.getBranch());
		const selection = parseSyntheticProfileSelection(ctx.model);
		if (selection) return { ...persisted, activeProfile: selection.profile, activeRole: selection.role };
		return persisted;
	}

	async function generateRecap(
		ctx: ExtensionContext,
		rt: RecapRuntime,
		source: RecapEntryData["source"],
		epochAtStart: number,
	): Promise<{ status: "success"; text: string; fingerprint: string } | { status: "failed"; message: string }> {
		const branch = ctx.sessionManager.getBranch();
		const fingerprint = computeTranscriptFingerprint(branch);
		const compactionCount = countCompactions(branch);
		const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());

		const useDelta =
			rt.config.summarizeMode === "delta" &&
			rt.deltaBase !== null &&
			rt.deltaBase.compactionCount === compactionCount &&
			rt.deltaBase.messageCount > 0 &&
			rt.deltaBase.messageCount < sessionContext.messages.length;
		const deltaBase = useDelta ? rt.deltaBase : null;

		const digest = buildRecapDigest(sessionContext.messages, {
			maxInputTokens: rt.config.maxInputTokens,
			sinceMessageIndex: deltaBase?.messageCount,
		});
		if (!digest.text.trim()) return { status: "failed", message: "nothing to recap yet" };

		const profilesConfig = loadModelProfilesConfig(ctx.cwd);
		// Never feed the synthetic profiles/* model back in as a fallback: it
		// would route the recap through model-profiles' provider stream and
		// mutate its persisted fallback state.
		const currentModel = ctx.model && !parseSyntheticProfileSelection(ctx.model) ? ctx.model : undefined;
		const resolved = await resolveRecapModel({
			modelRegistry: ctx.modelRegistry,
			config: profilesConfig.mergedConfig,
			recapConfig: rt.config,
			state: effectiveProfilesState(ctx),
			currentModel,
		});
		if (!resolved) return { status: "failed", message: "no recap model available" };

		const abort = new AbortController();
		rt.generationAbort = abort;
		const result = await runRecapCompletion({
			resolved,
			modelRegistry: ctx.modelRegistry,
			context: buildRecapContext({
				digest: digest.text,
				previousRecap: deltaBase?.text,
				systemPrompt: rt.config.prompt,
			}),
			timeoutMs: rt.config.generationTimeoutMs,
			signal: abort.signal,
		});
		rt.generationAbort = null;

		if (rt.epoch !== epochAtStart) return { status: "failed", message: "session changed during generation" };
		if (result.status === "aborted") return { status: "failed", message: "recap generation timed out" };
		if (result.status === "error") {
			return { status: "failed", message: `${result.message} (${describeResolvedModel(resolved)})` };
		}

		rt.deltaBase = { text: result.text, messageCount: digest.messageCount, compactionCount };
		const lastPersisted = readLastRecapEntry(ctx.sessionManager.getBranch());
		if (!lastPersisted || lastPersisted.fingerprint !== fingerprint || lastPersisted.text !== result.text) {
			try {
				pi.appendEntry<RecapEntryData>(RECAP_ENTRY_CUSTOM_TYPE, {
					text: result.text,
					fingerprint,
					messageCount: digest.messageCount,
					compactionCount,
					generatedAt: Date.now(),
					source,
				});
			} catch {
				// Persistence is best-effort; the recap still displays.
			}
		}
		return { status: "success", text: result.text, fingerprint };
	}

	/** Automatic path: gate, generate in the background, display per mode. Fail silent. */
	async function maybeGenerateAndShow(ctx: ExtensionContext, rt: RecapRuntime): Promise<void> {
		if (rt.generationInFlight || !rt.autoEnabled) return;
		const options = gateOptions(rt.config);
		const env = triggerEnvironment(ctx, rt);
		const now = Date.now();

		// A matching recap may already be cached (focus flapping, resume, or a
		// previous display attempt that was gated). Idle-timer mode shows it
		// here; focus-idle mode shows it on focus-in.
		if (!shouldGenerate(rt.state, now, options, env)) {
			if (effectiveTriggerMode(rt.state, options) === "idle-timer" && rt.state.cache?.fingerprint === env.fingerprint) {
				if (shouldShow(rt.state, now, options, env)) showCachedRecap(ctx, rt);
				else if (!rt.state.shownSinceActivity) armRetryTimer(ctx, rt);
			}
			return;
		}

		const epochAtStart = rt.epoch;
		rt.generationInFlight = true;
		try {
			const generated = await generateRecap(ctx, rt, "auto", epochAtStart);
			if (rt.epoch !== epochAtStart) return; // stale: discard silently
			if (generated.status !== "success") {
				// Fail silent, but stay alive: one retry per idle period.
				armTimer(ctx, rt, rt.config.idleThresholdMs);
				return;
			}
			rt.state = onGenerated(rt.state, { text: generated.text, fingerprint: generated.fingerprint });

			const postEnv = triggerEnvironment(ctx, rt);
			const postNow = Date.now();
			const mode = effectiveTriggerMode(rt.state, options);
			if (mode === "idle-timer" || rt.state.focus === "focused") {
				if (shouldShow(rt.state, postNow, options, postEnv)) showCachedRecap(ctx, rt);
				else if (mode === "focus-idle") rt.state = deferShowToFocusIn(rt.state);
				else armRetryTimer(ctx, rt); // display gated (e.g. composing); retry cheaply
			} else {
				rt.state = deferShowToFocusIn(rt.state);
			}
		} catch {
			// Automatic recap must never surface errors or block the prompt.
		} finally {
			rt.generationInFlight = false;
			rt.generationAbort = null;
		}
	}

	function showCachedRecap(ctx: ExtensionContext, rt: RecapRuntime): void {
		const cache = rt.state.cache;
		if (!cache) return;
		showWidget(ctx, rt, recapView(ctx, rt, cache.text));
		rt.state = onShown(rt.state);
	}

	// ---- timers ---------------------------------------------------------------

	function clearTimer(rt: RecapRuntime): void {
		if (rt.timer !== null) {
			clearTimeout(rt.timer);
			rt.timer = null;
		}
	}

	function armTimer(ctx: ExtensionContext, rt: RecapRuntime, delayMs: number): void {
		clearTimer(rt);
		if (!rt.autoEnabled) return;
		// Re-assert focus reporting on every arm: a Ctrl+Z suspend or external
		// editor handoff resets terminal modes behind our back, and re-enabling
		// is an idempotent no-op when the mode is already set.
		if (rt.focusReportingEnabled) writeToTerminal(ENABLE_FOCUS_REPORTING);
		rt.timer = setTimeout(() => {
			rt.timer = null;
			void maybeGenerateAndShow(ctx, rt);
		}, delayMs);
	}

	/** Arm for the idle edge, measured from the last turn end. */
	function armIdleTimer(ctx: ExtensionContext, rt: RecapRuntime): void {
		const delay = msUntilIdleThreshold(rt.state, Date.now(), gateOptions(rt.config));
		if (delay === null) return;
		armTimer(ctx, rt, delay + Math.max(25, rt.config.focusDebounceMs));
	}

	/** Cheap re-check while a valid recap waits for display (no token spend). */
	function armRetryTimer(ctx: ExtensionContext, rt: RecapRuntime): void {
		armTimer(ctx, rt, Math.max(rt.config.focusDebounceMs, 5_000));
	}

	// ---- focus handling -------------------------------------------------------

	function handleFocusIn(ctx: ExtensionContext, rt: RecapRuntime, allowShow: boolean): void {
		rt.state = onFocusChange(rt.state, "focused");
		if (!allowShow || !rt.state.pendingShowOnFocusIn) return;
		const env = triggerEnvironment(ctx, rt);
		if (shouldShow(rt.state, Date.now(), gateOptions(rt.config), env)) {
			showCachedRecap(ctx, rt);
		}
		// If a draft blocked it, pendingShowOnFocusIn stays set; retried next focus-in.
	}

	function handleFocusOut(ctx: ExtensionContext, rt: RecapRuntime): void {
		rt.state = onFocusChange(rt.state, "unfocused");
		armIdleTimer(ctx, rt);
	}

	// ---- lifecycle -------------------------------------------------------------

	function teardown(ctx: ExtensionContext | null): void {
		if (!runtime) return;
		clearTimer(runtime);
		runtime.generationAbort?.abort();
		runtime.generationAbort = null;
		runtime.unsubscribeInput?.();
		runtime.unsubscribeInput = null;
		if (runtime.focusReportingEnabled) {
			runtime.focusReportingEnabled = false;
			writeToTerminal(DISABLE_FOCUS_REPORTING);
		}
		if (ctx) clearWidget(ctx, runtime);
		runtime = null;
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		teardown(ctx);

		const loaded = loadRecapConfig(ctx.cwd);
		const config = loaded.mergedConfig;
		if (ctx.hasUI) {
			for (const error of loaded.errors) {
				ctx.ui.notify(`recap config error: ${error.path}: ${error.message}`, "warning");
			}
			if (config.commandName !== registeredCommandName) {
				ctx.ui.notify(
					`recap: commandName "${config.commandName}" takes effect after restarting pi (currently /${registeredCommandName})`,
					"warning",
				);
			}
		}
		const autoEnabled =
			ctx.hasUI && isRecapAutoEnabled({ config, disableFlag: pi.getFlag(RECAP_DISABLE_FLAG) });

		const branch = ctx.sessionManager.getBranch();
		const state: TriggerState = reseedTurns(createTriggerState(), countCompletedTurns(branch), Date.now());

		const rt: RecapRuntime = {
			config,
			autoEnabled,
			state,
			deltaBase: null,
			timer: null,
			unsubscribeInput: null,
			focusReportingEnabled: false,
			generationInFlight: false,
			generationAbort: null,
			epoch: 0,
			widgetView: null,
			widgetMounted: false,
			tui: null,
		};
		runtime = rt;

		// Seed from the last persisted recap: the delta base for incremental
		// summarization, and — when the transcript has not changed at all — the
		// display cache, so a resume + idle never regenerates an identical recap.
		const lastRecap = readLastRecapEntry(branch);
		if (lastRecap && lastRecap.compactionCount === countCompactions(branch)) {
			rt.deltaBase = {
				text: lastRecap.text,
				messageCount: lastRecap.messageCount,
				compactionCount: lastRecap.compactionCount,
			};
			if (lastRecap.fingerprint === computeTranscriptFingerprint(branch)) {
				rt.state = onGenerated(rt.state, { text: lastRecap.text, fingerprint: lastRecap.fingerprint });
			}
		}

		if (!ctx.hasUI) return;

		// The input subscription runs whenever a UI exists — keystroke dismissal
		// of a /recap widget must work even with the automatic recap disabled.
		rt.unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const current = runtime;
			const currentCtx = lastCtx;
			if (!current || !currentCtx) return undefined;
			// Pasted content may contain literal focus-report bytes; never parse it.
			if (isBracketedPaste(data)) {
				if (current.widgetMounted) clearWidget(currentCtx, current);
				return undefined;
			}
			const parsed = parseFocusEvents(data);
			if (parsed.stripped) {
				// Focus-in followed by keystrokes in the same chunk must not show
				// (and instantly burn) the recap: display only on a pure focus chunk.
				const allowShow = parsed.remaining.length === 0;
				for (const event of parsed.events) {
					if (event === "focus-in") handleFocusIn(currentCtx, current, allowShow);
					else handleFocusOut(currentCtx, current);
				}
				if (parsed.remaining.length === 0) return { consume: true };
				if (current.widgetMounted) clearWidget(currentCtx, current);
				return { data: parsed.remaining };
			}
			// Any real keystroke dismisses a shown recap (mirrors Claude Code).
			if (current.widgetMounted) clearWidget(currentCtx, current);
			return undefined;
		});

		if (!autoEnabled) return;

		if (config.useFocusReporting && config.trigger === "focus-idle") {
			if (writeToTerminal(ENABLE_FOCUS_REPORTING)) {
				rt.focusReportingEnabled = true;
				installExitRestore();
			}
		}

		armIdleTimer(ctx, rt);
	});

	pi.on("turn_end", (event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		rt.state = isCompletedAssistantTurn(event.message)
			? onTurnEnd(rt.state, Date.now())
			: onActivity(rt.state, Date.now());
		clearWidget(ctx, rt);
		armIdleTimer(ctx, rt);
	});

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		clearTimer(rt);
		clearWidget(ctx, rt);
	});

	pi.on("input", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		clearWidget(ctx, rt);
	});

	pi.on("session_compact", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		rt.epoch += 1;
		rt.generationAbort?.abort();
		rt.state = invalidateCache(rt.state);
		rt.deltaBase = null;
		clearWidget(ctx, rt);
	});

	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		rt.epoch += 1;
		rt.generationAbort?.abort();
		rt.state = invalidateCache(rt.state);
		// The gates must evaluate the branch we navigated TO, not the one we left.
		rt.state = reseedTurns(rt.state, countCompletedTurns(ctx.sessionManager.getBranch()), Date.now());
		rt.deltaBase = null;
		clearWidget(ctx, rt);
		armIdleTimer(ctx, rt);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		teardown(ctx);
	});

	pi.registerCommand(registeredCommandName, {
		description: "Show a one-line recap of the session so far",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("recap requires interactive mode", "error");
				return;
			}
			// session_start always builds the runtime before commands can run.
			const rt = runtime;
			if (!rt) {
				ctx.ui.notify("recap is not initialized yet", "error");
				return;
			}
			if (rt.generationInFlight) {
				ctx.ui.notify("recap already generating", "info");
				return;
			}

			showWidget(ctx, rt, { ...recapView(ctx, rt, ""), generating: true });
			const epochAtStart = rt.epoch;
			rt.generationInFlight = true;
			try {
				const generated = await generateRecap(ctx, rt, "command", epochAtStart);
				if (rt.epoch !== epochAtStart) {
					clearWidget(ctx, rt);
					return;
				}
				if (generated.status === "failed") {
					clearWidget(ctx, rt);
					ctx.ui.notify(`recap failed: ${generated.message}`, "error");
					return;
				}
				rt.state = onGenerated(rt.state, { text: generated.text, fingerprint: generated.fingerprint });
				showWidget(ctx, rt, recapView(ctx, rt, generated.text));
				rt.state = onShown(rt.state);
			} catch (error) {
				clearWidget(ctx, rt);
				ctx.ui.notify(`recap failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				rt.generationInFlight = false;
				rt.generationAbort = null;
			}
		},
	});
}
