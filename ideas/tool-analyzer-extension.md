# GitHub issue draft: `tool-lens` streaming tool-call intent/outcome analysis

## Title

feat(pi): add `tool-lens` for streaming tool-call intent/outcome analysis

## Problem

Pi shows tool calls and results, but users still have to infer:

- why the agent called this tool now
- what the agent expected to learn or change
- whether the result matched that intent
- what changed in the session after the tool finished

This gets harder when tools run in parallel, outputs are long, or the agent calls provider-native aliases (`shell_command`, `apply_patch`, `read_file`, etc.).

## Proposal

Add a new `tool-lens` Pi extension that observes main-agent tool calls without changing them and runs a cheap/fast analyzer model as a sidecar.

For each main-agent tool call:

1. When the tool call starts, stream an intent analysis:
   - tool name
   - redacted/truncated inputs
   - inferred intent
   - expected outcome
   - why this call makes sense in the current session
   - notable risk or ambiguity
2. While the tool runs, show execution state and optional partial-output signal.
3. When the tool result finishes, stream an outcome analysis:
   - what happened
   - whether it matched the inferred intent
   - key outputs/errors/side effects
   - suggested next-step implication for the main agent

The analyzer must work in parallel with the main agent loop: fail open, avoid blocking tool execution, and never change tool behavior.

## Resolved product choices

- Name: `tool-lens`.
- Scope: all configured tool calls by default, scoped per tool call.
- Filtering: allowlist/blocklist in config.
- Analyzer model: explicit config first, then model-profile role such as `tool-lens`/`smol` for cheap per-profile defaults.
- Privacy: redacted/truncated tool inputs and outputs may be sent to the analyzer model.
- Context default: recent visible conversation only; more context is configurable.
- Tone: terse operator notes with educational/guiding phrasing.
- Judgment scope: describe intent and outcome; do not grade the agent broadly.
- Surface: hybrid. A live transient HUD during execution, then persisted inline cards flushed at idle, backed by hidden audit entries.
- Live-ness: intent streams during the tool run; outcome streams the moment each tool finishes.
- Cost rule: never append to the transcript while the agent is streaming (that triggers an extra LLM turn); only flush cards when idle.
- Visibility: one user toggle shows/hides both the HUD and the cards globally without mutating the session.

## Pushback / important constraint

Pi's current public extension API supports live widgets/status updates and persisted custom entries/messages. I did not find a public API for streaming updates into a custom transcript message exactly like assistant token streaming, nor a public API for adding typed metadata to an existing tool-call/tool-result entry after it has been persisted.

So there are two implementation tracks:

1. Extension-only v1: inline context-stripped `custom_message` card per tool call (Option B), optional Option C wrapper for built-ins/provider-profile tools, optional live ticker/digest.
2. Pi core-enhanced v1: add a first-class tool annotation/streaming custom-entry API so `tool-lens` can render inside each tool block and persist typed metadata alongside tool calls without mutating tool results.

If the requirement is literally "toggle this exact tool block between raw and analysis", we likely need the Pi core-enhanced track.

## User value

- Better operator trust: see intention before confusing or risky calls complete.
- Better debugging: correlate inputs, outputs, and session goal without reading raw logs.
- Better parallel-tool visibility: understand sibling tool calls independently.
- Better onboarding: users learn what the agent is doing without interrupting it.

## Non-goals

- Do not ask `tool-lens` to approve/block tools. That is a separate permission extension.
- Do not mutate tool inputs or tool outputs.
- Do not expose secrets, raw environment values, or unredacted large outputs to the analyzer model.
- Do not require BAML for v1 unless structured extraction becomes necessary.
- Do not replace built-in/provider-profile tools just to change rendering.

## Rendering constraints (verified against Pi source)

Checked `modes/interactive/components/tool-execution.js`, `interactive-mode.js`, `core/session-manager.js`, `core/extensions/types.d.ts`:

- A tool row is drawn by exactly one renderer: `toolDefinition.renderResult ?? builtInToolDefinition.renderResult`. The only way to draw inside a tool row is to be that tool's `renderResult`.
- `getAllTools()` returns `ToolInfo` (`name|description|parameters|promptGuidelines` + sourceInfo) only. It does not expose other tools' `execute`/`renderResult`, so arbitrary third-party tools cannot be generically wrapped.
- A tool row has one view toggle only: `expanded` (ctrl+o/ctrl+e). No second view-mode axis exists today.
- `custom_message` entries with `display:true` render inline via the registered message renderer, but they also enter LLM context unless removed in the `context` hook.
- `custom` entries (`appendEntry`) never enter context and never render in the transcript (tree-selector only).
- Widgets are global single-slot panels docked above/below the editor; not per-tool, not in scrollback.

Implication: "stack on another tool's renderer without overriding it" is not directly possible for arbitrary tools. The viable Pi-compatible paths are below.

## UX options

### Option A: live sidecar widget below editor

`ctx.ui.setWidget("tool-lens", ..., { placement: "belowEditor" })`.

Pros: extension-only, streams live, no renderer conflict.
Cons: fixed panel near editor, not in scrollback, shows only current/last N, analysis detached from the call. Weak as a primary surface.

Best for: optional live ticker, not default.

### Option B: inline adjacent card per tool, stripped from context (recommended default)

After each tool result, append a `custom_message` rendered by `registerMessageRenderer("tool-lens", ...)`, and drop those entries in the `context` hook so the LLM never sees them.

Pros:

- Renders inline directly under the tool row.
- Own look; own expand/collapse state.
- Persists in session (scrollback, reload, fork).
- Context-safe: `context` hook filters them before the model call.
- No tool re-registration, so no conflict with `provider-tool-profiles`; works for every tool.

Cons:

- It is an adjacent card, not the same row, so there is no true "hide raw, show only analysis" swap.
- Adds one transcript block per analyzed tool call (mitigate with collapsed-by-default and density config).

Toggle: expand/collapse the lens card; optional `/tool-lens hide|show` flips a module flag and re-renders.

### Option C: renderResult wrapper for wrappable tools (opt-in, true raw/lens toggle)

For built-ins (reconstructable via `createReadTool`/`createBashTool`/`createEditTool`/`createWriteTool`) and the in-repo `provider-tool-profiles` tools, register a wrapper that delegates `execute` to the original and composes `renderResult`.

Pros:

- True raw/lens in the same tool row.
- Reuses `expanded`, or capture `context.invalidate` per `toolCallId` and add `/tool-lens toggle` for a dedicated mode flip.

Cons / caveat:

- Co-owning a tool name means last registration wins; tool-lens must import and wrap the profile/built-in tool and coordinate load order. Fragile and does not generalize to unknown third-party tools.

Best for: opt-in enhancement on common tools, not the generic path.

### Option D: per-turn digest message

At `turn_end`/`agent_end`, persist one `tool-lens` summary (also context-stripped). Low noise, good archive, but not per-tool streaming.

## Surface model (hybrid, decided)

Two render surfaces plus a durable store, each used at the moment it is actually allowed by the Pi API.

```
during execution  ->  live transient HUD      (belowEditor widget, streams now)
on idle (agent_end) -> persisted inline cards  (transcript custom_message, scrollback)
throughout         ->  hidden audit entries    (custom entries, no turn, no context)
```

1. Live HUD: a below-editor widget fed by the in-memory store. Intent streams while the tool runs; outcome streams as each tool finishes. This is the streaming, main-loop-like feel. Ephemeral, shows the current batch, auto-clears at turn end.
2. Persisted cards: at `agent_end`, when `ctx.isIdle()` is true, flush one `custom_message` card per analyzed tool call in source order. Durable, inline, expandable, toggleable. No extra LLM turn because the agent is idle.
3. Audit entries: per-phase `custom` entries (`appendEntry`) written during the run. Never in context, never trigger a turn, used to rebuild the store on reload/fork.

### Why hybrid (verified API constraints)

- The only transcript injection path is `pi.sendMessage` (a `custom_message`).
- During streaming that goes through the steer/followUp queue, which re-enters the agent inner loop and triggers an extra `streamAssistantResponse` call (verified in `pi-agent-core/agent-loop.js`). The `context` strip removes pollution but not the wasted call.
- Appending only while idle (`ctx.isIdle()` after `agent_end`) avoids the extra turn entirely.
- So per-tool cards cannot stream inline between a tool start and result today. The HUD covers the live per-tool moment; cards provide permanence.

### Delivery / cost gate (must verify before build)

Load-bearing assumption: append-at-idle adds no LLM call. Prove with a small SDK spike (`createAgentSession` + a fake model counting provider calls): run one tool, flush a card at idle, assert provider call count unchanged. Treat as a build gate; if false, fall back to digest-at-idle.

### terminate:true tools

A batch terminates only if every finalized call returns `terminate: true` (verified `shouldTerminateToolBatch`). For terminating tools (e.g. `structured_output`): never steer/followUp a card; show HUD + write audit during, flush cards at idle like everything else.

## Async update mechanism

Per tool call, keyed by `toolCallId`:

- `tool_execution_start`: seed the store record; start intent analysis. Never await in `tool_call` (it can block execution). HUD shows the new row immediately.
- `tool_execution_update`: update store partial state only (HUD ticks).
- `tool_execution_end`: kick off outcome analysis here (earliest signal, fires per tool in completion order). Capture redacted result/details.
- On any analysis delta/finish: write latest to the store and call `ctx.ui.setStatus("tool-lens", ...)` (verified to call `requestRender()`), repainting the HUD.
- `agent_end` + idle: flush persisted cards in source order; append final audit entries; clear the HUD.

Repaint mechanics (verified):

- HUD widget and card components read the shared store on each `render(width)`; never block render on the model.
- `setStatus` forces a frame and doubles as a footer progress/visibility indicator.

## Parallel tool calls (decided)

Verified event ordering in `pi-agent-core/agent-loop.js` (`executeToolCallsParallel`):

```
tool_execution_start   SOURCE order, all upfront, before any execution (preflight)
tool_execution_update  interleaved (concurrent)
tool_execution_end     COMPLETION order (per tool, as each finishes)
tool_result messages   SOURCE order (after Promise.all)
agent_end              once, after the whole batch
```

Design consequences:

- Fan out all intents at `tool_execution_start`: every start fires before any execution, so all intent analyses run concurrently with the tools. Best case for "ahead of execution."
- Kick off each outcome at `tool_execution_end`: a fast tool's outcome streams while slow siblings still run. Completion order is only the analysis-kickoff order, never the display order.
- Display order is always source order, for both HUD rows and flushed cards, matching the tool rows. No scramble.
- The HUD is multi-row: it shows the whole current batch, one independent row per `toolCallId` (scoped per tool call, not semantically grouped; they coexist because concurrent).

Cost control under fan-out:

- One global analyzer semaphore across the batch (`maxConcurrentAnalyses`), FIFO in source order. A 5-tool batch does not launch 10 concurrent analyses.
- Late-merge: if a tool reaches `tool_execution_end` before its queued intent analysis has started, skip the standalone intent and run a single combined intent+outcome call. Saves a model call and avoids stale intent (~1 analysis/tool under load instead of 2).
- Budget overflow: beyond `limits.maxAnalysesPerTurn`, render rows/cards as "not analyzed (batch over budget)" rather than queueing unbounded.

Parallel edge cases:

- Immediate/blocked calls (`preparation.kind === "immediate"`, e.g. blocked by a `tool_call` hook): start + end, no execution, no update. Card/HUD shows "did not execute (blocked/cached)".
- Sequential mode (`toolExecution: "sequential"` or any `executionMode: "sequential"` tool): start -> end -> result one at a time; HUD shows one active row. Same code path; `toolCallId` keying handles it.
- Error result: both `tool_execution_end` and `tool_result` carry `isError`; outcome notes it.

## Visibility toggle

Hard requirement: the user can show/hide all lens output on demand, covering both HUD and cards.

Design (no session mutation, verified mechanics):

- Module-level `visibility` state: `full | compact | hidden`.
- HUD: `full` shows streaming rows; `compact` shows a one-line batch summary; `hidden` clears the widget.
- Cards: the custom renderer switches per paint: `full` = intent/outcome card honoring expand/collapse; `compact` = one-line summary; `hidden` = a single dim stub line.
- `pi.registerShortcut(...)` and a `/tool-lens` command cycle/set the state, then call `ctx.ui.setStatus(...)` to force a repaint and reflect the mode in the footer.
- Caveat: `CustomMessageComponent` always prepends one blank `Spacer(1)` line, so card `hidden` cannot be zero-height; use a one-line stub. True zero-height hide needs a Pi core display flag (separate issue).
- Global expand/collapse (ctrl+o `setToolsExpanded`) already propagates to custom-message components, so cards get density control for free; visibility is an independent axis.
- Default visibility and density come from config.

## Recommended UX path

1. v1: hybrid surface (live HUD + idle-flushed cards + audit entries), with the global visibility toggle and per-card expand/collapse.
2. Optional behind config: per-turn digest (Option D).
3. Deferred: same-row `renderResult` wrapper for built-ins/provider-tool-profiles (Option C).
4. Core follow-up for true inline streaming under each tool row and a generic raw/lens toggle: add a Pi annotation/display API so `renderResult` context exposes annotations keyed by `toolCallId` plus a view mode and streaming updates, removing the need to co-own tool names and the idle-flush compromise.

## UX sketch

Live HUD during a parallel batch (belowEditor widget, streaming):

```text
tool-lens · turn 7
A  read  src/a.ts      intent ✓   done     matched
B  bash  bun test      intent ✓   running  4.2s
C  read  src/c.ts      analyzing… running
```

Persisted cards after idle flush (source order, scrollback), collapsed then expanded:

```text
● apply_patch  config.ts  +12 -3                      (real tool row, untouched)

  lens  apply_patch                                    (idle-flushed card, ctrl+o to expand)
  intent: update defaults, keep project-over-global precedence
  outcome: applied; only normalize/merge changed; matched intent
```

```text
● bash  bun test render/config.test.ts  done           (real tool row)

  lens  bash                                            (expanded)
  intent: verify config parser after merge change
  why now: parser/merge just edited in this session
  expected: pass, or failures pinpoint normalize/merge regressions
  outcome: passed; confirms edited cases; no runtime smoke yet
  implication: optional broader smoke before shipping
```

Visibility states (same session, no data loss):

```text
full     ● bash ...   lens card with intent/outcome   | HUD: streaming rows
compact  ● bash ...   lens: verify config; passed ✓    | HUD: one-line batch
hidden   ● bash ...   (lens hidden)                    | HUD: cleared
```

Optional per-turn digest (Option D, context-stripped):

```text
Tool lens: 4 calls, 4 analyzed, 1 partial match, 0 errors
```

All inputs/outputs shown are redacted and truncated; cards are collapsed by default.

## Persistence model

### Hard constraint: sessions are append-only

Verified in `core/session-manager.d.ts`: the only mutating APIs are `append*` and `setLabel`. There is no API to edit/replace/patch an existing entry's `content` or `details`. So a record written at tool-start cannot be backfilled with the outcome. The data model must treat every persisted entry as immutable once written.

Second verified fact: a `custom_message`'s `content` enters LLM context (we strip it in the `context` hook), but its `details` never enters context. So all analysis text lives in `details`, and `content` stays near-empty. This keeps analysis out of the model even if the strip is ever bypassed.

### Store + audit + idle-flushed cards (decided)

The hybrid removes the need for a positioned placeholder. Each persisted card is written once, at idle, with complete data, so append-only is satisfied naturally (no backfill of an existing entry).

Three pieces, keyed by `toolCallId`:

1. Store (in-memory `Map<toolCallId, ToolLensRecordV1>`): live source of truth during the run. Feeds the HUD. Updated as intent/outcome stream.
2. Audit entries (`custom` via `pi.appendEntry`): durable, per-phase, written during the run. They never render, never enter context, and do not trigger a turn (verified: custom entries are session-only, not agent messages), so they are safe to append mid-stream. Purpose: crash/reload recovery for analysis that completed before its card was flushed.
3. Cards (`custom_message` via `pi.sendMessage`): the persisted transcript artifact, flushed only when idle. `content` near-empty, `details` carries the full final `ToolLensRecordV1`, so a reloaded card renders directly from `details` without needing the store.

Lifecycle:

- `tool_execution_start`: seed store; start intent analysis; HUD shows the row.
- intent completes: update store; append `custom` audit `{ phase: "intent" }`; repaint HUD.
- `tool_execution_end`: start outcome analysis; capture redacted result/details.
- outcome completes: update store; append `custom` audit `{ phase: "outcome" }`; repaint HUD.
- `agent_end` + `ctx.isIdle()`: flush one consolidated card per analyzed tool call, source order, full `details`; clear HUD.
- analysis that completes after `agent_end` while still idle: flush its card immediately; if a new turn has started, defer to the next idle.
- `session_start`: reconstruct by scanning the current branch. Prefer flushed card `details`; for any tool with audit entries but no card (crash before flush), rebuild from the latest audit phase and flush the missing card while idle.

Why per-phase audit (decided): survives a mid-tool crash and preserves intent even if outcome never arrives; cost is up to two small hidden entries per tool. Latest phase wins on reconstruction.

### Versioned payload

```ts
type ToolLensVisibility = "full" | "compact" | "hidden";
type ToolLensPhase = "intent" | "outcome";

// Written to custom audit entries (per phase) and, consolidated, to card details.
interface ToolLensRecordV1 {
  schema: "tool-lens.analysis.v1";
  toolCallId: string;         // sole correlation key
  turnIndex: number;
  sourceOrder: number;        // assistant source index, for stable display ordering
  toolName: string;           // as called
  canonicalToolName?: string; // alias-normalized (shell_command -> bash, etc.)
  phase?: ToolLensPhase;      // set on audit entries; omitted on consolidated card
  startedAt: number;
  completedAt?: number;
  // Tiered capture (decided): intent/outcome text + redacted input snapshot +
  // redacted output summary by default; tool details only for edit/apply_patch.
  input?: RedactedPayload;          // redacted/truncated args snapshot
  outputSummary?: RedactedPayload;  // redacted/truncated visible content summary
  toolDetails?: RedactedPayload;    // only for edit/apply_patch: diff stats, file lists, counts
  intent?: ToolLensIntent;          // from the intent phase
  outcome?: ToolLensOutcome;        // from the outcome phase
  status: "observed" | "intent_streaming" | "executing" | "outcome_streaming" | "done" | "error" | "not_analyzed";
  errors?: string[];
}
```

- `toolCallId` is the only correlation key (decided); no assistant/toolResult entry-id scanning in v1.
- `sourceOrder` preserves source-order display for HUD rows and flushed cards under parallel batches.
- A tolerant `normalize()` (same pattern as `render`/`answer`) ignores unknown fields and renders missing fields as `unknown`.
- Reconstruction walks only the current branch (`getBranch`); off-branch tool calls show no lens (decided).

Rules:

- The `context` hook MUST drop every `tool-lens` card message from the copy sent to the LLM (cards flushed at idle still enter context on the next turn otherwise).
- All analysis text stays in `details`/audit entries, never in `content`.
- Never store raw secrets or unredacted long outputs.
- Never mutate existing tool result `details`; lens data is separate.
- Retention is session-embedded only in v1; no separate cross-session disk log (a disk log is a distinct future consent from send-to-analyzer).

### Resolved: no start-time anchor

Earlier drafts considered appending a positioned placeholder at `tool_execution_start`. The hybrid makes that unnecessary: the live HUD covers the per-tool moment during execution, and cards are flushed once at idle with complete data. This avoids orphan placeholders for tools that never resolve and avoids any extra-turn risk from streaming-time appends.

### Desired Pi core support

Add a typed annotation layer for tool calls/results:

```ts
pi.appendToolAnnotation(toolCallId, {
  namespace: "tool-lens",
  schema: "tool-lens.analysis.v1",
  phase: "intent" | "outcome",
  data,
  display: true,
});
```

Renderer support:

```ts
renderResult(result, options, theme, context) {
  const lens = context.annotations?.get("tool-lens");
  if (context.viewMode === "lens") return renderLens(lens);
  return renderRaw(result);
}
```

Core requirements:

- annotations persist in session file as entries keyed by `toolCallId`
- annotations do not participate in LLM context by default
- annotations survive session resume/fork/tree navigation
- renderer context exposes annotations for that tool call
- TUI has per-tool view mode toggle: raw/lens
- streaming updates can update an annotation before finalization

This avoids stuffing analyzer metadata into tool result `details`, which may be sent back to the LLM and may belong to the tool implementation.

## Declarative config

Config files:

- global: `~/.pi/agent/tool-lens.json`
- project: `.pi/tool-lens.json`

Project overrides global. Env escape hatches:

- `PI_TOOL_LENS=0` disables
- `PI_TOOL_LENS_RENDER=full|compact|hidden` overrides default visibility
- `PI_TOOL_LENS_HUD=0` disables the live HUD (cards only); `PI_TOOL_LENS_CARDS=0` disables persisted cards (HUD only)

Suggested schema:

```json
{
  "enabled": true,
  "mode": "intent-and-outcome",
  "tools": {
    "allowList": ["*"],
    "blockList": [],
    "aliases": {
      "shell_command": "bash",
      "run_shell_command": "bash",
      "read_file": "read",
      "apply_patch": "edit"
    }
  },
  "modelSelection": {
    "roleCandidates": ["tool-lens", "smol"],
    "useActiveProfile": true,
    "fallbackToActiveRole": false,
    "fallbackToDefaultRole": false,
    "provider": null,
    "model": null,
    "thinkingLevel": "minimal"
  },
  "analysis": {
    "promptStyle": "terse-operator-guide",
    "maxIntentBullets": 4,
    "maxOutcomeBullets": 5,
    "includeRisks": true,
    "includeNextStepImplication": true,
    "stream": true,
    "timeoutMs": 20000,
    "intentKickoff": "tool_execution_start",
    "outcomeKickoff": "tool_execution_end",
    "maxConcurrentAnalyses": 2,
    "lateMerge": true
  },
  "context": {
    "preset": "visible-recent",
    "maxMessages": 8,
    "maxChars": 12000,
    "includeSystemPrompt": false,
    "includeContextFiles": false,
    "includeToolDescriptions": false,
    "includePriorToolResults": true,
    "includeAssistantTextAroundToolCall": true
  },
  "capture": {
    "input": "redacted-snapshot",
    "output": "redacted-summary",
    "toolDetails": "edit-and-apply_patch-only"
  },
  "redaction": {
    "enabled": true,
    "redactEnvLikeValues": true,
    "redactPaths": false,
    "onFailure": "skip",
    "extraPatterns": []
  },
  "persistence": {
    "cardFlush": "on-idle",
    "auditEntries": "per-phase",
    "reconstructFrom": "current-branch",
    "crossSessionLog": false
  },
  "limits": {
    "maxInputChars": 4000,
    "maxOutputChars": 8000,
    "maxAnalysesPerTurn": 24
  },
  "rendering": {
    "liveHud": true,
    "hudPlacement": "belowEditor",
    "hudMaxRows": 8,
    "persistCards": true,
    "stripFromContext": true,
    "defaultVisibility": "full",
    "visibilityCycle": ["full", "compact", "hidden"],
    "toggleShortcut": "ctrl+l",
    "order": "assistant-source",
    "showRawInputs": "redacted-collapsed",
    "showRawOutputs": "summary-only",
    "expandedByDefault": false,
    "persistDigestMessage": false,
    "wrapTools": []
  },
  "privacy": {
    "sendInputsToAnalyzer": true,
    "sendOutputsToAnalyzer": true,
    "localModelOnly": false
  }
}
```

Config notes:

- `mode`: `intent-only | outcome-only | intent-and-outcome`.
- `tools.allowList`/`tools.blockList`: match tool names after alias normalization; blocklist wins.
- `analysis.intentKickoff` / `outcomeKickoff`: intent at `tool_execution_start` (concurrent with the tool), outcome at `tool_execution_end` (per tool, earliest signal).
- `analysis.maxConcurrentAnalyses`: one global semaphore across the whole batch, FIFO in source order.
- `analysis.lateMerge`: if a tool ends before its intent analysis started, run a single combined intent+outcome call.
- `rendering.liveHud` / `hudPlacement` / `hudMaxRows`: the live transient HUD during execution.
- `rendering.persistCards`: flush per-tool cards to the transcript at idle.
- `rendering.stripFromContext`: must stay true so flushed cards are removed in the `context` hook before the next LLM call.
- `rendering.defaultVisibility` / `visibilityCycle` / `toggleShortcut`: global show/hide for HUD and cards (`full | compact | hidden`).
- `rendering.wrapTools`: deferred Option C list of wrappable tool names; ignored in v1.
- `capture.*`: per-tier persistence; `toolDetails` captured only for `edit`/`apply_patch` by default.
- `redaction.onFailure`: `skip` renders a "redaction failed, not analyzed" card and skips the model call.
- `persistence.cardFlush`: `on-idle` only; never append cards while the agent is streaming.
- `persistence.auditEntries`: `per-phase` appends intent then outcome `custom` entries; latest phase wins on reload.
- `persistence.crossSessionLog`: must stay false in v1; a disk log is a separate future consent.
- A generic same-row toggle and true inline streaming need the core annotation/view-mode API (separate issue).
- Analyzer model should receive no tools in its context.

## Architecture plan

### Files

Create `pi/extensions/tool-lens/`:

- `index.ts`: Pi extension entrypoint and event wiring.
- `config.ts`: load/normalize/merge global + project config, env overrides.
- `types.ts`: config, state machine, persisted metadata, analysis result types.
- `model-selection.ts`: reuse model-profile resolver pattern from `render`.
- `context.ts`: build compact session/tool context for analyzer prompts.
- `redaction.ts`: redact/truncate tool inputs/results before render/model calls/persistence.
- `prompts.ts`: intent and outcome prompt builders.
- `analyzer.ts`: streaming model runner, global batch semaphore, late-merge, cancellation, retries/timeouts.
- `store.ts`: in-memory `toolCallId`-keyed analysis store; audit-entry append + reconstruction.
- `hud.ts`: live transient HUD widget (multi-row, source-ordered) fed by the store.
- `flush.ts`: idle-gated card flush at `agent_end` (`ctx.isIdle()`), source order, full `details`.
- `card.ts`: custom message renderer for flushed cards (full/compact/hidden states).
- `visibility.ts`: global visibility state, shortcut + `/tool-lens` command, repaint trigger.
- `README.md`: install, config, privacy warnings, the delivery/cost gate spike, smoke prompts.
- `*.test.ts`: config, redaction, context builder, store/reconstruction, semaphore/late-merge, state machine, HUD/card renderers, idle-flush.

### Event flow

Use Pi extension events documented in `docs/extensions.md`:

- `session_start`: load config; register the card renderer (`registerMessageRenderer("tool-lens", ...)`), the visibility shortcut, and `/tool-lens`; restore visibility; init footer status and HUD; rebuild the store by scanning the current branch (`getBranch`), preferring flushed card `details`, else latest audit phase per `toolCallId`; while idle, flush any card that has audit data but no card.
- `context`: remove every `tool-lens` card message from the deep-copied message list so analysis never reaches the LLM. Mandatory.
- `before_agent_start`: capture the user prompt and optional context metadata summary, not the full system prompt by default.
- `turn_start`: initialize per-turn batch state and HUD for the new batch.
- `tool_execution_start` (all fire upfront, source order): seed the store record; show the HUD row; start intent analysis via `void queueIntent(...)` through the batch semaphore. Never append to the transcript here.
  - If hooking `tool_call` instead, return immediately; never await the analyzer there because `tool_call` can block execution.
- `tool_execution_update`: update store partial state; HUD ticks.
- `tool_execution_end` (per tool, completion order): start outcome analysis (or a combined intent+outcome call if late-merge applies); capture redacted result/details; on intent/outcome completion append the matching `custom` audit entry and repaint the HUD.
- `tool_result`: capture redacted visible content if not already taken; return `undefined`, never patch the result.
- `agent_end` + `ctx.isIdle()`: flush one consolidated card per analyzed tool call in source order with full `details`; clear the HUD. If analysis is still pending, flush a partial card now and a corrected one at the next idle.
- analysis completing after `agent_end` while idle: flush immediately; if a new turn already started, defer to the next idle.
- On any analysis delta/finish: update the store and call `ctx.ui.setStatus("tool-lens", ...)` to force a repaint.
- `turn_end`: optional digest only if enabled.
- `session_shutdown`: abort pending analyzer streams; clear HUD and footer status.

Cost rule (verified): appending a `custom_message` while streaming is queued via steer/followUp and triggers an extra LLM turn. All card appends happen only when `ctx.isIdle()`. Audit `custom` entries are session-only and safe to append mid-stream.

### State machine

Per tool call (keyed by `toolCallId`):

```text
observed
  -> intent_streaming        (or skipped if late-merge)
  -> executing
  -> outcome_streaming       (combined intent+outcome if late-merge)
  -> done
```

Failure / special branches:

```text
intent_error    -> executing -> outcome_streaming -> done
outcome_error   -> done (intent preserved)
redaction_error -> not_analyzed
blocked/immediate -> not_analyzed (did not execute)
cancelled       -> done
```

Rules:

- Key by `toolCallId`; carry `sourceOrder` for display.
- Display in source order (HUD rows and flushed cards); completion order only drives analysis kickoff.
- Each tool call is independent; no semantic grouping.
- Analyzer failure/timeout never fails or mutates the main tool call.
- Backpressure: one global batch semaphore (`maxConcurrentAnalyses`), FIFO by source order; beyond budget, mark `not_analyzed`.
- Cards are written once at idle from the final store record; reconstruction prefers card `details`, else latest audit phase.

### Analyzer prompt contract

Intent prompt returns concise Markdown. It must answer:

- `Intent`: what the tool call is trying to accomplish.
- `Why now`: what visible session context makes this call useful.
- `Expected`: what useful result would look like.
- `Watch`: risk, ambiguity, or likely failure mode.

Outcome prompt returns concise Markdown. It must answer:

- `Result`: what happened.
- `Matched intent`: yes/no/partial/unknown plus why.
- `Important details`: outputs, errors, files changed, counts, truncation.
- `Implication`: what the main agent likely should do next.

Prompt constraints:

- No tool use.
- Do not reveal hidden/system prompt content.
- Say `unknown` when intent cannot be inferred.
- Preserve uncertainty.
- Prefer session-specific reasoning over generic tool explanations.
- Avoid broad agent judgment; stay on intent/outcome for this tool call.

### Rendering plan

Hybrid v1, extension-only and context-safe:

Live HUD (during execution):

- `ctx.ui.setWidget("tool-lens", factory, { placement: "belowEditor" })` for a multi-row, source-ordered widget fed by the store.
- `ctx.ui.setStatus("tool-lens", ...)` to force frames as analysis streams and to show batch progress.
- Auto-clear the widget at `agent_end`.

Persisted cards (at idle):

- `pi.sendMessage({ customType: "tool-lens", display: true, details })` only when `ctx.isIdle()`, one card per analyzed tool call in source order; `details` carries the full final record, `content` near-empty.
- `pi.registerMessageRenderer("tool-lens", ...)` renders full/compact/hidden, honoring expand/collapse.
- `context` hook removes all `tool-lens` card messages from the copy sent to the LLM.

Audit (during execution):

- `pi.appendEntry("tool-lens", record)` per phase for crash/reload recovery; never rendered, never in context.

Optional:

- Option D digest via a separate context-stripped `tool-lens-digest` custom message at idle.

Deferred (Option C) and core-enhanced target rendering (separate Pi issue):

- Reconstruct built-ins via `createReadTool`/`createBashTool`/`createEditTool`/`createWriteTool` or import in-repo `provider-tool-profiles` tools; wrap `execute` + compose `renderResult` raw/lens (load-order coordination required).
- Core API: `renderResult` context exposes annotations keyed by `toolCallId`, a raw/lens view mode, and streaming updates, enabling true inline per-row streaming without tool co-ownership or the idle-flush compromise.

### Privacy/security

- Redact before both model prompt and rendering.
- Never log raw tool inputs/outputs by default.
- Avoid env dumps, token-like strings, auth headers, `.env` content, private keys.
- Default `includeSystemPrompt=false` and `includeContextFiles=false`.
- Default output truncation with visible truncation metadata.
- Analyzer model auth uses `ctx.modelRegistry.getApiKeyAndHeaders`; never print keys.
- Fail closed for analyzer data collection if redaction throws, but fail open for main tool execution.

### Testing plan

Unit tests:

- Config normalization/merge/env overrides.
- Tool allowlist/blocklist/alias matching.
- Redaction for env vars, API-key-like tokens, private key blocks, auth headers.
- Input/output truncation metadata.
- Session context builder from fake branch entries.
- Prompt builders include required fields and omit system/context files by default.
- State machine handles interleaved parallel tool events (start source order, end completion order).
- Store reconstructs latest metadata by `toolCallId`, preferring card `details` over audit phase.
- Batch semaphore respects `maxConcurrentAnalyses`; late-merge collapses to one combined call when intent had not started.
- Idle-flush gate: cards append only when idle; a fake provider-call counter proves no extra LLM turn (the delivery/cost spike).
- HUD renders multi-row in source order; visibility toggle switches HUD and cards across full/compact/hidden.
- Renderer produces stable collapsed/expanded text; `not_analyzed` path renders on redaction failure / over-budget / blocked.

Manual smoke:

```bash
pi --extension ./pi/extensions/tool-lens/index.ts
```

Prompts:

1. "Read README.md and summarize the repo."
2. "Run the render config tests and explain any failure."
3. "Make a harmless edit then inspect git diff."
4. "Run two independent searches in parallel if possible."

Expected:

- Intent appears in the live HUD while the tool executes.
- Outcome appears in the HUD as each tool finishes (per tool under parallel).
- At idle, persisted cards appear in source order and survive reload/fork.
- No extra LLM turn is triggered by card flushing (watch token/turn count).
- Main tool execution is not blocked by analyzer latency.
- Redacted/truncated inputs/outputs appear in HUD, cards, and audit entries.

## Acceptance criteria

- [ ] New `pi/extensions/tool-lens/` extension can be loaded directly by Pi.
- [ ] Declarative config loads from global and project paths, project wins, env can disable.
- [ ] Analyzer observes all allowed tool calls across built-in and provider-tool-profile names.
- [ ] Tool allowlist/blocklist and alias normalization work; blocklist wins.
- [ ] Intent analysis kicks off at `tool_execution_start` (concurrent with the tool), without awaiting the model in any blocking hook.
- [ ] Outcome analysis kicks off at `tool_execution_end` per tool; under parallel batches a fast tool's outcome can stream while siblings run.
- [ ] Live HUD streams intent during execution and outcome as each tool finishes, multi-row in source order.
- [ ] Persisted cards are flushed only when `ctx.isIdle()` (at `agent_end`); flushing triggers no extra LLM turn (proven by the delivery/cost spike).
- [ ] Flushed cards are stripped from LLM context via the `context` hook.
- [ ] A global visibility toggle (shortcut + `/tool-lens`) cycles full/compact/hidden for HUD and cards without mutating the session, persisted for the session.
- [ ] Per-card expand/collapse works and reacts to global ctrl+o.
- [ ] Store + per-phase `custom` audit + idle-flushed cards: state survives reload/fork by scanning the current branch (card `details` preferred, else latest audit phase).
- [ ] Treats sessions as append-only: each card is written once with complete data; no edit/replace of any entry; no start-time placeholder.
- [ ] All analysis text lives in `details`/audit entries; card `content` stays near-empty so nothing leaks even if the context strip is bypassed.
- [ ] Capture tiers honored: intent/outcome + redacted input + redacted output summary by default; tool `details` only for `edit`/`apply_patch`.
- [ ] Redaction failure skips the model call and marks the call `not_analyzed`.
- [ ] Retention is session-embedded only; no cross-session disk log in v1.
- [ ] Configurable model selection supports explicit provider/model and cheap model-profile roles (`tool-lens`, `smol`).
- [ ] Default context is recent visible conversation; system prompt/context files/tool descriptions are opt-in.
- [ ] Inputs/outputs are redacted and truncated before analyzer model calls and before persistence.
- [ ] Parallel tool calls: intents fan out at start, outcomes stream per tool at end, display stays source-ordered, cost bounded by one batch semaphore + late-merge.
- [ ] Blocked/immediate and `terminate:true` tools are handled (no extra turn; HUD + audit + idle card).
- [ ] Analyzer errors/timeouts are visible but never fail or mutate the main tool call.
- [ ] Unit tests cover config, redaction, context building, store reconstruction, semaphore/late-merge, idle-flush (no extra turn), state transitions, HUD/card rendering.
- [ ] README documents config, privacy implications, UX modes, and smoke prompts.

## Core follow-up acceptance criteria for raw/lens toggle

- [ ] Pi can persist extension annotations keyed by `toolCallId` without adding them to LLM context.
- [ ] Tool render context exposes annotations for that tool call.
- [ ] Extensions can stream/update annotation content while a tool is running.
- [ ] TUI has a per-tool raw/lens toggle distinct from expand/collapse.
- [ ] Existing built-in and provider-profile tool renderers can opt into lens rendering without re-registering/replacing tools.

## Resolved decisions

- Surface: hybrid live HUD + idle-flushed persisted cards + hidden audit entries.
- Intent at `tool_execution_start`, outcome at `tool_execution_end`.
- Cards flush only when `ctx.isIdle()`; never append while streaming (avoids extra LLM turn).
- Parallel: fan out intents at start, stream outcomes per tool at end, display in source order, one batch semaphore + late-merge.
- Persistence: append-only; one consolidated card per call written once; per-phase audit for recovery; reconstruct from current branch.
- Capture tiers: intent/outcome + redacted input + redacted output summary; tool `details` only for `edit`/`apply_patch`.
- Redaction failure: skip model call, mark `not_analyzed`.
- Retention: session-embedded only; no cross-session disk log in v1.
- Digest (Option D) default off; Option C deferred; core annotation API is a separate linked issue.

## Open items before final issue

1. Delivery/cost spike: confirm append-at-idle adds no LLM turn (build gate). If false, fall back to digest-at-idle.
2. Visibility keybinding: default `ctrl+l` (note: some terminals map it to clear-screen). Confirm or pick another; `/tool-lens [full|compact|hidden|toggle]` either way.
3. Keep three visibility states (`full|compact|hidden`) or reduce HUD to binary show/hide.

## Implementation order

1. Delivery/cost spike: SDK harness with a fake provider-call counter; prove append-at-idle adds no LLM turn. Gate the rest on this.
2. Scaffold `tool-lens` extension, config loader, README stub.
3. Implement redaction/truncation + tiered capture, tests first.
4. Implement the store, per-phase audit append, and branch reconstruction with tests.
5. Implement the analyzer runner: streaming, global batch semaphore, late-merge, timeout/cancel, with fake-stream tests.
6. Implement context/prompt builders and tests.
7. Implement the live HUD widget (multi-row, source order) from the store.
8. Implement the idle-flush card path and `tool-lens` card renderer (full/compact/hidden).
9. Implement the visibility module (shortcut + `/tool-lens`) over HUD and cards.
10. Wire Pi events with fail-open behavior, including the mandatory `context` strip and `terminate:true`/blocked handling.
11. Add optional digest behind config; add smoke docs and manual test notes.
12. Open a separate Pi core issue for tool annotations + inline streaming + generic raw/lens toggle.
