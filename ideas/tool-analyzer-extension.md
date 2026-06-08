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
- Surface: Option B inline adjacent cards as the only v1 surface.
- Visibility: a user toggle shows/hides all lens cards globally without mutating the session.

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

## Async update mechanism

The lens card is appended right after the tool row, then filled in as analysis streams:

- `tool_call`/`tool_execution_start`: append the card in `observed` state and start intent analysis. Never await in `tool_call` (it can block execution).
- `tool_result`: start outcome analysis; return `undefined`, never patch the result.
- On stream progress/finish: write the latest text to the `toolCallId`-keyed store, then trigger a repaint.

Repaint mechanics (verified against Pi source):

- The card is a custom component returned by `registerMessageRenderer`. Its `render(width)` runs every paint, so it reads the shared store and renders the latest intent/outcome each frame.
- To force a frame after async analysis lands, call `ctx.ui.setStatus("tool-lens", ...)`, which internally calls `requestRender()`. The status text doubles as a progress/visibility indicator.
- Do not block `render()` on the model; rendering only reads cached store state.

## Visibility toggle

This is a hard requirement: the user can show/hide all lens cards on demand.

Design (no session mutation, verified mechanics):

- Keep a module-level `visibility` state: `full | compact | hidden`.
- The custom renderer switches on it every paint:
  - `full`: intent/outcome card, honoring expand/collapse.
  - `compact`: one-line summary (tool name + matched/again indicator).
  - `hidden`: a single dim placeholder line.
- A keybinding via `pi.registerShortcut(...)` and a `/tool-lens` command both cycle/set the state, then call `ctx.ui.setStatus(...)` to force a repaint and reflect the mode in the footer.
- Caveat: `CustomMessageComponent` always prepends one blank `Spacer(1)` line, so `hidden` cannot be zero-height; use a minimal one-line stub. Fully removing the gap would need a Pi core display flag (separate issue).
- Global expand/collapse (ctrl+o `setToolsExpanded`) already propagates to custom-message components, so the card gets density control for free; the visibility toggle is an independent axis.
- Default visibility and default density come from config.

## Recommended UX path

1. v1: Option B inline adjacent cards only, context-stripped, with the global visibility toggle and per-card expand/collapse.
2. Optional behind config: Option A live ticker, Option D digest.
3. Deferred: Option C same-row wrapper for built-ins/provider-tool-profiles.
4. Core follow-up for a generic same-row raw/lens toggle and zero-height hide: add a Pi annotation/display API so `renderResult` context exposes annotations keyed by `toolCallId` plus a view mode, removing the need to co-own tool names.

## UX sketch

Option B inline adjacent card (default), collapsed then expanded:

```text
● apply_patch  config.ts  +12 -3                      (real tool row, untouched)

  lens  apply_patch                                    (adjacent custom card, ctrl+o to expand)
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

Visibility toggle states (same session, no data loss):

```text
full     ● bash ...        lens card with intent/outcome
compact  ● bash ...        lens: verify config; passed ✓
hidden   ● bash ...        (lens hidden)
```

Option C same-row toggle (deferred, wrappable tools only):

```text
● read  README.md  42 lines                    [▸ raw | lens]
  lens: confirm repo layout before editing; expecting extension list
```

Option A live ticker (optional, belowEditor widget):

```text
tool-lens
[2] apply_patch  running 0.4s   intent: keep project>global precedence
```

Option D per-turn digest message (optional, context-stripped):

```text
Tool lens: 4 calls, 4 analyzed, 1 partial match, 0 errors
```

All inputs/outputs shown are redacted and truncated; cards are collapsed by default.

## Persistence model

### Current Pi-compatible v1

Default (Option B): the inline card is a context-stripped `custom_message` carrying typed `details`; the `context` hook removes these from the LLM message list. Optionally also write a hidden `custom` entry via `pi.appendEntry()` for a non-context audit trail. Both use the same versioned payload shape.

Example shape:

```ts
interface ToolLensEntryV1 {
  schema: "tool-lens.analysis.v1";
  sessionId?: string;
  turnIndex?: number;
  toolCallId: string;
  toolName: string;
  canonicalToolName?: string;
  assistantEntryId?: string;
  toolResultEntryId?: string;
  order: number;
  startedAt: number;
  endedAt?: number;
  input: RedactedPayload;
  output?: RedactedPayload;
  intent?: ToolLensIntent;
  outcome?: ToolLensOutcome;
  status: "observed" | "intent_streaming" | "executing" | "outcome_streaming" | "done" | "error";
  errors?: string[];
}
```

Notes:

- Primary persisted artifact is one context-stripped `custom_message` per tool call, updated/replaced as intent then outcome land, keyed by `toolCallId` in `details`.
- The `context` hook MUST drop every `tool-lens` custom message from the copy sent to the LLM, so analysis never pollutes model context.
- Optionally mirror final state into a hidden `custom` entry for audit; reconstruct latest by `toolCallId` on `session_start`.
- Do not store raw secrets or unredacted long outputs.
- Do not mutate existing tool result `details`.

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
- `PI_TOOL_LENS_RENDER=inline-card|ticker|digest|off` overrides render surface where supported

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
    "maxConcurrentAnalyses": 2
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
  "redaction": {
    "enabled": true,
    "redactEnvLikeValues": true,
    "redactPaths": false,
    "extraPatterns": []
  },
  "limits": {
    "maxInputChars": 4000,
    "maxOutputChars": 8000,
    "maxRenderedCalls": 12,
    "maxPersistedCalls": 50
  },
  "rendering": {
    "surface": "inline-card",
    "stripFromContext": true,
    "defaultVisibility": "full",
    "visibilityCycle": ["full", "compact", "hidden"],
    "toggleShortcut": "ctrl+l",
    "showRawInputs": "redacted-collapsed",
    "showRawOutputs": "summary-only",
    "order": "assistant-source",
    "expandedByDefault": false,
    "persistAuditEntry": false,
    "liveTicker": false,
    "tickerPlacement": "belowEditor",
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
- `rendering.surface`: `inline-card` (Option B, default, the only supported v1 surface) | `ticker` (Option A) | `digest` (Option D) | `off`.
- `rendering.stripFromContext`: must stay true so analysis is removed in the `context` hook before the LLM call.
- `rendering.defaultVisibility` / `visibilityCycle` / `toggleShortcut`: drive the global show/hide toggle (`full | compact | hidden`).
- `rendering.wrapTools`: deferred Option C list of wrappable tool names; ignored in v1.
- A generic same-row toggle for all tools needs the core annotation/view-mode API (separate issue).
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
- `analyzer.ts`: streaming model runner, queue, cancellation, retries/timeouts.
- `store.ts`: in-memory `toolCallId`-keyed analysis store plus optional audit-entry read/write.
- `card.ts`: custom message renderer for the inline lens card (full/compact/hidden states).
- `visibility.ts`: global visibility state, shortcut + `/tool-lens` command, repaint trigger.
- `README.md`: install, config, smoke prompts, privacy warnings.
- `*.test.ts`: config, redaction, context builder, store, state machine, renderer.

### Event flow

Use Pi extension events documented in `docs/extensions.md`:

- `session_start`: load config, register `registerMessageRenderer("tool-lens", ...)`, register the visibility shortcut and `/tool-lens` command, restore visibility state, initialize footer status.
- `context`: remove every `tool-lens` custom message from the deep-copied message list so analysis never reaches the LLM. This is mandatory.
- `before_agent_start`: capture current user prompt and optional context metadata summary, not full system prompt by default.
- `turn_start`: initialize per-turn state.
- `tool_execution_start` (preferred) or `tool_call`: create the `toolCallId` record (tool name, args, source order, timestamp); append the inline lens card via `sendMessage({ customType: "tool-lens", display: true, details })` in `observed` state.
  - If hooking `tool_call`, return immediately; never await the analyzer model there because `tool_call` can block execution.
  - Kick off intent analysis with `void queueIntentAnalysis(...)`.
- `tool_execution_update`: update store partial state only.
- `tool_result`: capture final content/details/isError and kick off outcome analysis; return `undefined`, never patch result.
- `tool_execution_end`: finalize duration/error metadata.
- On any analysis delta/finish: update the store and call `ctx.ui.setStatus("tool-lens", ...)` to force a repaint of the card.
- `turn_end`/`agent_end`: optionally write audit entries / digest if enabled.
- `session_shutdown`: abort pending analyzer streams and clear footer status.

### State machine

Per tool call:

```text
observed
  -> intent_streaming
  -> executing
  -> outcome_streaming
  -> done
```

Failure branches:

```text
intent_error -> executing -> outcome_streaming -> done
outcome_error -> done
cancelled -> done
```

Rules:

- Key by `toolCallId`.
- Display each call independently; no grouping by default.
- Preserve assistant source order for display, but allow completion-order updates.
- Analyzer failure never fails the main agent turn.
- Backpressure: max concurrent analyzer model streams, queue or skip older/lower-priority calls.

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

Default (Option B), extension-only and context-safe:

- `pi.sendMessage({ customType: "tool-lens", display: true, details })` to append an inline card after each analyzed tool result.
- `pi.registerMessageRenderer("tool-lens", ...)` for collapsed/expanded card rendering.
- `context` hook removes all `tool-lens` custom messages from the copy sent to the LLM.
- `pi.appendEntry("tool-lens", data)` only if a hidden, non-context audit record is also wanted; otherwise the custom message detail carries state.
- On streamed analysis updates, re-render the card component for that `toolCallId`.

Opt-in (Option C), same-row toggle on wrappable tools:

- Reconstruct built-ins via `createReadTool`/`createBashTool`/`createEditTool`/`createWriteTool`, or import in-repo `provider-tool-profiles` tools.
- Register a wrapper that delegates `execute` to the original and composes `renderResult` raw/lens.
- Store lens state by `toolCallId`; call captured `context.invalidate()` when analysis lands.
- Document load-order/ownership coordination with `provider-tool-profiles`.

Optional surfaces:

- Option A live ticker via `ctx.ui.setWidget` / `ctx.ui.setStatus`.
- Option D digest via a separate context-stripped `tool-lens-digest` custom message.

Core-enhanced target rendering (separate Pi issue):

- Tool render context exposes annotations keyed by `toolCallId`.
- Tool row gains a raw/lens view mode distinct from expand.
- tool-lens streams updates into the annotation; no tool-name co-ownership required.

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
- State machine handles interleaved parallel tool events.
- Store reconstructs latest metadata by `toolCallId` across custom entries.
- Queue respects concurrency, timeout, cancellation.
- Renderer produces stable collapsed/expanded text.

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

- Intent appears before/while the tool executes.
- Outcome appears after result.
- Main tool execution is not blocked by analyzer latency.
- Redacted/truncated inputs/outputs appear in UI and persisted metadata.

## Acceptance criteria

- [ ] New `pi/extensions/tool-lens/` extension can be loaded directly by Pi.
- [ ] Declarative config loads from global and project paths, project wins, env can disable.
- [ ] Analyzer observes all allowed tool calls across built-in and provider-tool-profile names.
- [ ] Tool allowlist/blocklist and alias normalization work; blocklist wins.
- [ ] Intent analysis starts on tool call start without awaiting model completion in blocking hooks.
- [ ] Outcome analysis starts after final tool result.
- [ ] Inline lens cards render per tool call, update as analysis streams, and are stripped from LLM context via the `context` hook.
- [ ] A global visibility toggle (shortcut + `/tool-lens`) cycles full/compact/hidden for all cards without mutating the session, and persists the choice for the session.
- [ ] Per-card expand/collapse works and reacts to global ctrl+o.
- [ ] Optional audit entry and optional per-turn digest persist only when enabled.
- [ ] Configurable model selection supports explicit provider/model and cheap model-profile roles (`tool-lens`, `smol`).
- [ ] Default context is recent visible conversation; system prompt/context files/tool descriptions are opt-in.
- [ ] Inputs/outputs are redacted and truncated before analyzer model calls and before persistence.
- [ ] Parallel tool calls render independently and tolerate interleaved updates.
- [ ] Analyzer errors/timeouts are visible but never fail or mutate the main tool call.
- [ ] Unit tests cover config, redaction, context building, store reconstruction, state transitions, and queue behavior.
- [ ] README documents config, privacy implications, UX modes, and smoke prompts.

## Core follow-up acceptance criteria for raw/lens toggle

- [ ] Pi can persist extension annotations keyed by `toolCallId` without adding them to LLM context.
- [ ] Tool render context exposes annotations for that tool call.
- [ ] Extensions can stream/update annotation content while a tool is running.
- [ ] TUI has a per-tool raw/lens toggle distinct from expand/collapse.
- [ ] Existing built-in and provider-profile tool renderers can opt into lens rendering without re-registering/replacing tools.

## Remaining grill questions

1. Digest/audit entries default off in v1 (inline cards are the surface). Confirm.
2. Should output analysis include tool `details` objects by default, or only visible `content`? Recommendation: include redacted/truncated details for file mutation counts/diffs, but cap aggressively.
3. For ultra-fast tools, still render the card and fill it when analysis lands (no skipping). Confirm.
4. Visibility toggle default keybinding `ctrl+l` and `/tool-lens [full|compact|hidden|toggle]`. Confirm keybinding choice.
5. Should the core annotation API be part of the same issue or separate follow-up? Recommendation: separate issue linked from this one unless toggle is mandatory for v1.

## Implementation order

1. Scaffold `tool-lens` extension, config loader, README stub.
2. Implement redaction/truncation and tests first.
3. Implement state machine and fake event tests.
4. Implement in-memory store and optional audit-entry persistence with tests.
5. Implement context/prompt builders and tests.
6. Implement analyzer streaming runner with fake stream tests.
7. Implement the inline card renderer (full/compact/hidden) and visibility module (shortcut + `/tool-lens`).
8. Wire Pi events with fail-open behavior, including the mandatory `context` strip.
9. Add optional audit-entry and digest renderers behind config.
10. Add smoke docs and manual test notes.
11. Open a separate Pi core issue for tool annotations + generic same-row toggle if desired.
