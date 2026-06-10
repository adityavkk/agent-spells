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
import { isRecapAutoEnabled, loadRecapConfig } from "./config";
import {
	DISABLE_FOCUS_REPORTING,
	ENABLE_FOCUS_REPORTING,
	parseFocusEvents,
} from "./focus";
import { resolveRecapModel } from "./model-selection";
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
	onFocusChange,
	onGenerated,
	onShown,
	onTurnEnd,
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
	idleTimer: ReturnType<typeof setTimeout> | null;
	unsubscribeInput: (() => void) | null;
	focusReportingEnabled: boolean;
	generationInFlight: boolean;
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

export default function recapExtension(pi: ExtensionAPI) {
	// The command name must be known at registration time; everything else is
	// (re)loaded with the session cwd on session_start.
	const startupConfig = loadRecapConfig(process.cwd()).mergedConfig;

	let runtime: RecapRuntime | null = null;
	let lastCtx: ExtensionContext | null = null;

	pi.registerFlag(RECAP_DISABLE_FLAG, {
		description: "Disable the automatic session recap for this run",
		type: "boolean",
	});

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
			ctx.ui.setWidget(
				RECAP_WIDGET_KEY,
				(tui, theme) => {
					rt.tui = tui;
					return createRecapWidgetComponent(() => rt.widgetView ?? view, theme);
				},
				{ placement: "aboveEditor" },
			);
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

	async function generateRecap(
		ctx: ExtensionContext,
		rt: RecapRuntime,
		source: RecapEntryData["source"],
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
		const profilesState = readModelProfilesState(branch);
		const resolved = await resolveRecapModel({
			modelRegistry: ctx.modelRegistry,
			config: profilesConfig.mergedConfig,
			recapConfig: rt.config,
			state: profilesState,
			currentModel: ctx.model,
		});
		if (!resolved) return { status: "failed", message: "no recap model available" };

		const result = await runRecapCompletion({
			resolved,
			modelRegistry: ctx.modelRegistry,
			context: buildRecapContext({
				digest: digest.text,
				previousRecap: deltaBase?.text,
				systemPrompt: rt.config.prompt,
			}),
			timeoutMs: rt.config.generationTimeoutMs,
		});
		if (result.status === "aborted") return { status: "failed", message: "recap generation timed out" };
		if (result.status === "error") {
			return { status: "failed", message: `${result.message} (${describeResolvedModel(resolved)})` };
		}

		rt.deltaBase = { text: result.text, messageCount: digest.messageCount, compactionCount };
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
		return { status: "success", text: result.text, fingerprint };
	}

	/** Automatic path: gate, generate in the background, display per mode. Fail silent. */
	async function maybeGenerateAndShow(ctx: ExtensionContext, rt: RecapRuntime): Promise<void> {
		if (rt.generationInFlight || !rt.autoEnabled) return;
		const options = gateOptions(rt.config);
		const env = triggerEnvironment(ctx, rt);
		const now = Date.now();

		// A matching recap may already be cached (e.g. focus flapping).
		if (!shouldGenerate(rt.state, now, options, env)) {
			if (effectiveTriggerMode(rt.state, options) === "idle-timer" && shouldShow(rt.state, now, options, env)) {
				showCachedRecap(ctx, rt);
			}
			return;
		}

		rt.generationInFlight = true;
		try {
			const generated = await generateRecap(ctx, rt, "auto");
			if (generated.status !== "success") return; // fail silent
			rt.state = onGenerated(rt.state, { text: generated.text, fingerprint: generated.fingerprint });

			const postEnv = triggerEnvironment(ctx, rt);
			const postNow = Date.now();
			const mode = effectiveTriggerMode(rt.state, options);
			if (mode === "idle-timer" || rt.state.focus === "focused") {
				if (shouldShow(rt.state, postNow, options, postEnv)) showCachedRecap(ctx, rt);
				else if (mode === "focus-idle") rt.state = deferShowToFocusIn(rt.state);
			} else {
				rt.state = deferShowToFocusIn(rt.state);
			}
		} catch {
			// Automatic recap must never surface errors or block the prompt.
		} finally {
			rt.generationInFlight = false;
		}
	}

	function showCachedRecap(ctx: ExtensionContext, rt: RecapRuntime): void {
		const cache = rt.state.cache;
		if (!cache) return;
		showWidget(ctx, rt, recapView(ctx, rt, cache.text));
		rt.state = onShown(rt.state);
	}

	// ---- idle timer ---------------------------------------------------------

	function clearIdleTimer(rt: RecapRuntime): void {
		if (rt.idleTimer !== null) {
			clearTimeout(rt.idleTimer);
			rt.idleTimer = null;
		}
	}

	function armIdleTimer(ctx: ExtensionContext, rt: RecapRuntime): void {
		clearIdleTimer(rt);
		if (!rt.autoEnabled) return;
		const delay = msUntilIdleThreshold(rt.state, Date.now(), gateOptions(rt.config));
		if (delay === null) return;
		rt.idleTimer = setTimeout(() => {
			rt.idleTimer = null;
			void maybeGenerateAndShow(ctx, rt);
		}, delay + Math.max(25, rt.config.focusDebounceMs));
	}

	// ---- focus handling -------------------------------------------------------

	function handleFocusIn(ctx: ExtensionContext, rt: RecapRuntime): void {
		rt.state = onFocusChange(rt.state, "focused");
		if (!rt.state.pendingShowOnFocusIn) return;
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
		clearIdleTimer(runtime);
		runtime.unsubscribeInput?.();
		runtime.unsubscribeInput = null;
		if (runtime.focusReportingEnabled) {
			runtime.focusReportingEnabled = false;
			try {
				process.stdout.write(DISABLE_FOCUS_REPORTING);
			} catch {
				// stdout may already be closed during shutdown.
			}
		}
		if (ctx) clearWidget(ctx, runtime);
		runtime = null;
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		teardown(ctx);

		const loaded = loadRecapConfig(ctx.cwd);
		const config = loaded.mergedConfig;
		const autoEnabled =
			ctx.hasUI && isRecapAutoEnabled({ config, disableFlag: pi.getFlag(RECAP_DISABLE_FLAG) });

		const branch = ctx.sessionManager.getBranch();
		const state: TriggerState = {
			...createTriggerState(),
			// Resumed sessions already have history; seed the turn gate from the
			// transcript and start the idle clock now.
			turnCount: countCompletedTurns(branch),
			lastTurnEndAt: Date.now(),
		};

		const rt: RecapRuntime = {
			config,
			autoEnabled,
			state,
			deltaBase: null,
			idleTimer: null,
			unsubscribeInput: null,
			focusReportingEnabled: false,
			generationInFlight: false,
			widgetView: null,
			widgetMounted: false,
			tui: null,
		};
		runtime = rt;

		// Seed delta summarization from the last persisted recap when the
		// transcript has not been rewritten since.
		const lastRecap = readLastRecapEntry(branch);
		if (lastRecap && lastRecap.compactionCount === countCompactions(branch)) {
			rt.deltaBase = {
				text: lastRecap.text,
				messageCount: lastRecap.messageCount,
				compactionCount: lastRecap.compactionCount,
			};
		}

		if (!autoEnabled) return;

		if (config.useFocusReporting && config.trigger === "focus-idle") {
			try {
				process.stdout.write(ENABLE_FOCUS_REPORTING);
				rt.focusReportingEnabled = true;
			} catch {
				// No focus reporting: trigger falls back to idle-timer semantics.
			}
		}

		rt.unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const current = runtime;
			const currentCtx = lastCtx;
			if (!current || !currentCtx) return undefined;
			const parsed = parseFocusEvents(data);
			if (parsed.stripped) {
				for (const event of parsed.events) {
					if (event === "focus-in") handleFocusIn(currentCtx, current);
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

		armIdleTimer(ctx, rt);
	});

	pi.on("turn_end", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		rt.state = onTurnEnd(rt.state, Date.now());
		clearWidget(ctx, rt);
		armIdleTimer(ctx, rt);
	});

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		clearIdleTimer(rt);
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
		rt.state = invalidateCache(rt.state);
		rt.deltaBase = null;
		clearWidget(ctx, rt);
	});

	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		const rt = runtime;
		if (!rt) return;
		rt.state = invalidateCache(rt.state);
		rt.deltaBase = null;
		clearWidget(ctx, rt);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		teardown(ctx);
	});

	pi.registerCommand(startupConfig.commandName, {
		description: "Show a one-line recap of the session so far",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("recap requires interactive mode", "error");
				return;
			}
			// /recap works even when the automatic recap is disabled.
			const rt: RecapRuntime =
				runtime ??
				{
					config: loadRecapConfig(ctx.cwd).mergedConfig,
					autoEnabled: false,
					state: createTriggerState(),
					deltaBase: null,
					idleTimer: null,
					unsubscribeInput: null,
					focusReportingEnabled: false,
					generationInFlight: false,
					widgetView: null,
					widgetMounted: false,
					tui: null,
				};
			if (rt.generationInFlight) {
				ctx.ui.notify("recap already generating", "info");
				return;
			}

			showWidget(ctx, rt, { ...recapView(ctx, rt, ""), generating: true });
			rt.generationInFlight = true;
			try {
				const generated = await generateRecap(ctx, rt, "command");
				if (generated.status === "failed") {
					clearWidget(ctx, rt);
					ctx.ui.notify(`recap failed: ${generated.message}`, "error");
					return;
				}
				rt.state = onGenerated(rt.state, { text: generated.text, fingerprint: generated.fingerprint });
				showWidget(ctx, rt, recapView(ctx, rt, generated.text));
				rt.state = onShown(rt.state);
			} finally {
				rt.generationInFlight = false;
			}
		},
	});
}
