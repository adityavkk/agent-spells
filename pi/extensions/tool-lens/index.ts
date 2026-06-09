/**
 * tool-lens: streaming tool-call intent/outcome analysis for Pi.
 *
 * Runs a cheap analyzer model as a sidecar to the main agent loop. It never
 * changes tool inputs/results and never blocks execution. Surfaces (hybrid):
 *   - live HUD below the editor during execution (streams intent, then outcome)
 *   - persisted cards flushed at idle (durable, inline, toggleable)
 *   - hidden per-phase audit entries for crash/reload recovery
 *
 * All model work happens off the blocking hooks; every handler is fail-open so a
 * slow or failing analyzer can never affect the main tool call.
 */
import { loadModelProfilesConfig } from "../model-profiles/config";
import { readModelProfilesState } from "../model-profiles/resolve";
import { Analyzer } from "./analyzer";
import { captureDetails, captureInput, captureOutput, shouldCaptureDetails } from "./capture";
import { loadToolLensConfig, resolveToolObservation } from "./config";
import { flushCards } from "./flush";
import { createModelRunner } from "./model-runner";
import { resolveToolLensModel } from "./model-selection";
import { ANALYZER_SYSTEM_PROMPT } from "./prompts";
import { buildAuditPayload, reconstructFromBranch, ToolLensStore, type BranchEntryLike } from "./store";
import { buildCardText, createHudComponent, type HudView } from "./ui";
import {
	TOOL_LENS_AUDIT_CUSTOM_TYPE,
	TOOL_LENS_CARD_CUSTOM_TYPE,
	TOOL_LENS_HUD_KEY,
	TOOL_LENS_STATUS_KEY,
	type LoadedToolLensConfig,
	type ToolLensCardDetails,
	type ToolLensConfig,
	type ToolLensPhase,
	type ToolLensRecordV1,
} from "./types";
import { VisibilityState } from "./visibility";
import { Text } from "./pi-compat";
import type { AgentMessage, ExtensionAPI, ExtensionCommandContext, ExtensionContext, KeyId } from "./pi-compat";

function isSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

export default function toolLensExtension(pi: ExtensionAPI): void {
	let loaded: LoadedToolLensConfig = loadToolLensConfig(process.cwd());
	let config: ToolLensConfig = loaded.mergedConfig;
	let store = new ToolLensStore();
	let analyzer: Analyzer | undefined;
	const flushed = new Set<string>();
	let visibility = new VisibilityState(config.rendering.defaultVisibility, config.rendering.visibilityCycle);
	let turnIndex = 0;
	let sourceCounter = 0;
	let hudRepaint: (() => void) | undefined;
	let enabledForSession = false;

	// ----- card renderer (always registered so reloaded sessions render) -----
	pi.registerMessageRenderer<ToolLensCardDetails>(TOOL_LENS_CARD_CUSTOM_TYPE, (message, { expanded }, theme) => {
		const record = message.details?.record;
		if (!record) return undefined;
		const text = buildCardText(record, visibility.value, expanded || config.rendering.expandedByDefault, theme);
		// Returning undefined would hide the row; an empty Text keeps a stable slot.
		return new Text(text, 0, 0);
	});

	function repaint(ctx: ExtensionContext): void {
		hudRepaint?.();
		const records = store.allSourceOrdered();
		const analyzed = records.filter((r) => r.status === "done").length;
		const status = records.length > 0 ? `lens ${analyzed}/${records.length}` : undefined;
		ctx.ui.setStatus(TOOL_LENS_STATUS_KEY, visibility.value === "hidden" ? "lens hidden" : status);
	}

	function ensureHud(ctx: ExtensionContext): void {
		if (!config.rendering.liveHud || !ctx.hasUI) return;
		const view = (): HudView => ({ visibility: visibility.value, turnIndex, maxRows: config.rendering.hudMaxRows });
		ctx.ui.setWidget(TOOL_LENS_HUD_KEY, (_tui, theme) => {
			const component = createHudComponent(store, view, theme);
			hudRepaint = (component as { repaint?: () => void }).repaint;
			return component;
		}, { placement: "belowEditor" });
	}

	function clearHud(ctx: ExtensionContext): void {
		hudRepaint = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(TOOL_LENS_HUD_KEY, undefined, { placement: "belowEditor" });
	}

	function appendAudit(record: ToolLensRecordV1, phase: ToolLensPhase): void {
		try {
			pi.appendEntry(TOOL_LENS_AUDIT_CUSTOM_TYPE, buildAuditPayload(record, phase));
		} catch {
			// Audit is best-effort recovery; never fail the run.
		}
	}

	function tryFlush(ctx: ExtensionContext): void {
		try {
			const ids = flushCards({
				store,
				flushed,
				sink: { send: (message) => pi.sendMessage(message) },
				isIdle: () => ctx.isIdle(),
				persistCards: config.rendering.persistCards,
			});
			if (ids.length > 0) repaint(ctx);
		} catch {
			// Flushing is best-effort; never break the session.
		}
	}

	async function buildAnalyzer(ctx: ExtensionContext): Promise<Analyzer | undefined> {
		try {
			const profiles = loadModelProfilesConfig(ctx.cwd);
			const state = readModelProfilesState(ctx.sessionManager.getBranch());
			const resolved = await resolveToolLensModel({
				modelRegistry: ctx.modelRegistry,
				config: profiles.mergedConfig,
				toolLensConfig: config,
				state,
				currentModel: ctx.model,
			});
			if (!resolved) return undefined;
			const runner = createModelRunner({ modelRegistry: ctx.modelRegistry, resolved, stream: config.analysis.stream });
			return new Analyzer(store, config, runner, ANALYZER_SYSTEM_PROMPT, {
				getMessages: () => ctx.sessionManager.getBranch().flatMap(branchEntryToMessage),
				onChange: () => repaint(ctx),
				onAudit: (record, phase) => {
					appendAudit(record, phase);
					tryFlush(ctx);
				},
			});
		} catch {
			return undefined;
		}
	}

	// ----- session lifecycle -----
	pi.on("session_start", async (_event, ctx) => {
		loaded = loadToolLensConfig(ctx.cwd);
		config = loaded.mergedConfig;
		store = new ToolLensStore();
		flushed.clear();
		visibility = new VisibilityState(config.rendering.defaultVisibility, config.rendering.visibilityCycle);
		visibility.subscribe(() => repaint(ctx));
		enabledForSession = config.enabled && !isSubagentChild();

		if (ctx.hasUI) {
			for (const error of loaded.errors) ctx.ui.notify(`tool-lens config error: ${error.path}: ${error.message}`, "warning");
		}
		if (!enabledForSession) {
			clearHud(ctx);
			ctx.ui.setStatus(TOOL_LENS_STATUS_KEY, undefined);
			return;
		}

		// Reconstruct prior records so reloaded/forked sessions keep their lens
		// state and flushed cards are not re-emitted.
		for (const record of reconstructFromBranch(ctx.sessionManager.getBranch() as BranchEntryLike[])) {
			store.put(record);
			flushed.add(record.toolCallId);
		}
		analyzer = await buildAnalyzer(ctx);
		ensureHud(ctx);
		repaint(ctx);
		// A crash before flush can leave audit-only records; flush them while idle.
		tryFlush(ctx);
	});

	// ----- mandatory context strip: never let cards reach the LLM -----
	pi.on("context", (event) => {
		if (!config.rendering.stripFromContext) return;
		const messages = (event.messages as Array<AgentMessage & { role?: string; customType?: string }>).filter(
			(message) => !(message.role === "custom" && message.customType === TOOL_LENS_CARD_CUSTOM_TYPE),
		);
		return { messages: messages as AgentMessage[] };
	});

	pi.on("turn_start", (event, ctx) => {
		if (!enabledForSession) return;
		turnIndex = event.turnIndex;
		analyzer?.resetTurn();
		repaint(ctx);
	});

	// ----- per-tool events (all fail-open, never await the model here) -----
	pi.on("tool_execution_start", (event, ctx) => {
		if (!enabledForSession || !analyzer) return;
		const { canonicalToolName, observed } = resolveToolObservation(event.toolName, config.tools);
		if (!observed) return;
		store.seed({
			toolCallId: event.toolCallId,
			turnIndex,
			sourceOrder: sourceCounter++,
			toolName: event.toolName,
			canonicalToolName,
			startedAt: Date.now(),
		});
		try {
			store.update(event.toolCallId, { input: captureInput(event.args, config), status: "observed" });
		} catch {
			store.update(event.toolCallId, { status: "not_analyzed" });
			store.appendError(event.toolCallId, "redaction failed");
			repaint(ctx);
			return;
		}
		analyzer.queueIntent(event.toolCallId);
		repaint(ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (!enabledForSession || !analyzer || !store.has(event.toolCallId)) return;
		store.setStatus(event.toolCallId, "executing");
		repaint(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!enabledForSession || !analyzer || !store.has(event.toolCallId)) return;
		const record = store.get(event.toolCallId)!;
		if (record.status === "not_analyzed") return;
		try {
			const patch: Partial<ToolLensRecordV1> = {
				outputSummary: captureOutput(event.result, config),
				completedAt: Date.now(),
			};
			if (shouldCaptureDetails(record.canonicalToolName ?? record.toolName, record.toolName, config)) {
				patch.toolDetails = captureDetails(extractDetails(event.result), config);
			}
			store.update(event.toolCallId, patch);
		} catch {
			store.update(event.toolCallId, { status: "not_analyzed" });
			store.appendError(event.toolCallId, "redaction failed");
			repaint(ctx);
			return;
		}
		analyzer.requestOutcome(event.toolCallId);
		repaint(ctx);
	});

	// ----- idle flush -----
	pi.on("agent_end", (_event, ctx) => {
		if (!enabledForSession) return;
		void (async () => {
			try {
				await analyzer?.idle();
			} catch {
				// ignore
			}
			tryFlush(ctx);
			clearHud(ctx);
		})();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		analyzer?.abort();
		clearHud(ctx);
		if (ctx.hasUI) ctx.ui.setStatus(TOOL_LENS_STATUS_KEY, undefined);
	});

	// ----- visibility toggle: shortcut + command (no session mutation) -----
	pi.registerShortcut(config.rendering.toggleShortcut as KeyId, {
		description: "Cycle tool-lens visibility (full/compact/hidden)",
		handler: (ctx) => {
			visibility.toggle();
			repaint(ctx);
			if (ctx.hasUI) ctx.ui.notify(`tool-lens: ${visibility.value}`, "info");
		},
	});

	pi.registerCommand("tool-lens", {
		description: "Set tool-lens visibility. Usage: /tool-lens [full|compact|hidden|toggle]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(`tool-lens visibility: ${visibility.value}`, "info");
				return;
			}
			const result = visibility.apply(arg);
			if (result === null) {
				ctx.ui.notify("Usage: /tool-lens [full|compact|hidden|toggle]", "error");
				return;
			}
			repaint(ctx);
			ctx.ui.notify(`tool-lens: ${result}`, "info");
		},
	});
}

/** Convert a session branch entry into analyzer context messages (role+content). */
function branchEntryToMessage(entry: unknown): Array<{ role?: string; customType?: string; content?: unknown }> {
	if (!entry || typeof entry !== "object") return [];
	const record = entry as { type?: string; message?: { role?: string; customType?: string; content?: unknown } };
	if (record.type !== "message" || !record.message) return [];
	return [record.message];
}

/** Best-effort extraction of structured details from a tool result object. */
function extractDetails(result: unknown): unknown {
	if (result && typeof result === "object" && "details" in (result as Record<string, unknown>)) {
		return (result as Record<string, unknown>).details;
	}
	return result;
}
