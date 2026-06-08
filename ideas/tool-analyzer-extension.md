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

## Pushback / important constraint

Pi's current public extension API supports live widgets/status updates and persisted custom entries/messages. I did not find a public API for streaming updates into a custom transcript message exactly like assistant token streaming, nor a public API for adding typed metadata to an existing tool-call/tool-result entry after it has been persisted.

So there are two implementation tracks:

1. Extension-only v1: live sidecar widget/status + versioned `appendEntry()` metadata keyed by `toolCallId` + optional visible final custom message.
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

## UX options

### Option A: live sidecar widget below editor

Use `ctx.ui.setWidget("tool-lens", ..., { placement: "belowEditor" })`.

Pros:

- Extension-only with current Pi API.
- Streams while the main agent continues.
- Does not compete with raw tool rendering.
- Good for quick v1.

Cons:

- Analysis is separated from the tool block.
- Less useful when transcript is scrolled back later unless persisted separately.
- Limited screen real estate.

Best for: first implementation, low-risk proof of value.

### Option B: right sidebar / docked lens pane

A persistent pane showing the active/recent tool calls with intent/outcome cards.

Pros:

- Strong operator-console feel.
- Keeps transcript raw while providing continuous analysis.
- Good for parallel calls and long-running sessions.

Cons:

- Pi extension API does not appear to expose a stable docked sidebar layout today.
- Likely needs core/TUI layout support, or an overlay approximation.
- More design work for terminal widths.

Best for: follow-up once core layout primitives exist.

### Option C: per-tool raw/analysis toggle

Each tool block can render either raw call/result or `tool-lens` analysis, similar spirit to `ctrl+o` expansion but with a second mode.

Possible states:

- collapsed raw summary
- expanded raw input/output
- collapsed lens summary
- expanded lens intent/outcome

Pros:

- Best mental model: analysis lives exactly where the tool call lives.
- Perfect for scrollback: replay a session and inspect each tool's why/result.
- Avoids separate sidecar state.

Cons:

- Needs renderer integration with existing built-in and provider-profile tool renderers.
- Tool-lens analysis may arrive after the tool result is already persisted/rendered.
- Current extension API can override tool renderers only by re-registering tools, which conflicts with other tool-profile extensions and is too invasive.

Best for: target UX, but should be backed by a Pi tool-annotation renderer API.

### Option D: inline transcript analysis message after each tool

Persist a custom message after each tool result, rendered compactly and collapsible.

Pros:

- Mostly compatible with current session format via `custom_message`.
- Easy to search and persist.
- Avoids mutating tool results.

Cons:

- Adds transcript noise.
- Custom messages participate in LLM context, unless Pi adds a display-only/custom-entry render path.
- Harder to pair visually with the exact tool block.

Best for: optional/debug mode, not default.

### Option E: final per-turn analysis digest

At `turn_end`/`agent_end`, persist one `tool-lens` summary message for all tool calls in that turn.

Pros:

- Low transcript noise.
- Easy to implement with current custom message renderer.
- Useful post-hoc summary.

Cons:

- Does not satisfy per-tool streaming UX by itself.
- Less precise than per-tool metadata.

Best for: optional archive/summarize mode.

## Recommended UX path

Implement in layers:

1. Extension-only v1:
   - live sidecar widget below editor
   - compact status counts in footer
   - versioned hidden `custom` entries keyed by `toolCallId`
   - optional final per-turn visible custom message
2. Core API follow-up:
   - first-class tool annotations keyed by `toolCallId`
   - renderer context can read annotations
   - tool blocks gain a raw/lens toggle
3. Later:
   - docked sidebar if/when Pi TUI exposes stable layout primitives

This keeps v1 compatible with Pi evolution while leaving a clear path to the desired raw/analysis toggle.

## UX sketch

Live widget, below editor by default:

```text
Tool lens

[1] shell_command  running  2.1s
Input: bun test pi/extensions/render/config.test.ts
Intent: Verify the render config parser after changing merge behavior.
Expected: Tests pass, or failures point at normalization/merge regressions.
Watch: Unit-only; does not verify live model selection.

Outcome: Passed. Confirms config behavior for the edited cases. No runtime smoke yet.

[2] apply_patch  done
Input: pi/extensions/render/config.ts
Intent: Update config defaults while preserving project-over-global precedence.
Outcome: Patch applied cleanly. Likely changed only normalization/merge code.
```

Target per-tool toggle:

```text
shell_command  done  3.4s  [raw] [lens]

Lens
Intent: Verify tests after config changes.
Expected: pass or identify changed failing assertions.
Outcome: Passed. No follow-up needed beyond broader smoke if desired.
```

Persisted per-turn message, if enabled:

```text
Tool lens: 4 calls, 4 analyzed, 1 partial match, 0 errors
```

Expanded message shows per-tool intent/outcome details with redacted inputs and output summaries.

## Persistence model

### Current Pi-compatible v1

Use versioned `custom` entries via `pi.appendEntry()` because they do not participate in LLM context.

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

- Store one final custom entry per tool call, or append phase entries (`intent`, `outcome`) and reconstruct latest by `toolCallId`.
- Do not store raw secrets or unredacted long outputs.
- Do not mutate existing tool result `details` in v1.
- Optional visible digest uses `custom_message`, but hidden metadata uses `custom`.

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
- `PI_TOOL_LENS_RENDER=widget|toggle|digest|off` overrides render surface where supported

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
    "surface": "widget",
    "placement": "belowEditor",
    "toolToggle": false,
    "showRawInputs": "redacted-collapsed",
    "showRawOutputs": "summary-only",
    "groupParallelTools": false,
    "order": "assistant-source",
    "persistMetadata": true,
    "persistDigestMessage": false,
    "expandedByDefault": false
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
- `rendering.surface`: v1 supports `widget | status | digest | off`; `toggle` needs core renderer/annotation support.
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
- `store.ts`: append/read versioned `tool-lens` custom entries by `toolCallId`.
- `renderer.ts`: widget/status renderer and custom message renderer.
- `README.md`: install, config, smoke prompts, privacy warnings.
- `*.test.ts`: config, redaction, context builder, store, state machine, renderer.

### Event flow

Use Pi extension events documented in `docs/extensions.md`:

- `session_start`: load config, restore persisted state from custom entries, register message renderer, initialize widget/status.
- `before_agent_start`: capture current user prompt and optional context metadata summary, not full system prompt by default.
- `turn_start`: initialize per-turn state.
- `tool_execution_start` or `tool_call`: create tool record with `toolCallId`, tool name, args, source order, timestamp.
  - Important: if using `tool_call`, return immediately; never await analyzer model there because `tool_call` can block execution.
  - Kick off intent analysis with `void queueIntentAnalysis(...)`.
- `tool_execution_update`: record optional partial result metadata, update render state only.
- `tool_result`: capture final content/details/isError and kick off outcome analysis.
  - Return `undefined`; never patch result.
- `tool_execution_end`: finalize duration/error metadata.
- `turn_end`/`agent_end`: append final metadata entries and optional digest message if configured.
- `session_shutdown`: abort pending analyzer streams and clear UI widgets/status.

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

V1 extension-only rendering:

- Use `ctx.ui.setWidget("tool-lens", ...)` for live streaming.
- Use `ctx.ui.setStatus("tool-lens", ...)` for compact progress/counts.
- Use `pi.appendEntry("tool-lens", data)` for hidden typed metadata.
- Use `pi.registerMessageRenderer("tool-lens-digest", ...)` for optional persisted digest messages.
- Use `pi.sendMessage({ customType: "tool-lens-digest", display: true, details })` only if digest persistence is enabled.

Core-enhanced target rendering:

- Tool result component gets a raw/lens view toggle.
- Tool render context exposes annotations for that tool call.
- Tool-lens streams updates into the annotation and finalizes it on outcome.

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
- [ ] Live widget/status updates stream analyzer text while the main agent loop continues.
- [ ] Hidden versioned metadata persists per tool call via Pi-compatible custom entries.
- [ ] Optional per-turn digest can be persisted as a custom message with custom renderer.
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

1. For v1, should visible digest messages be default off? Recommendation: off, metadata on.
2. Should output analysis include tool `details` objects by default, or only visible `content`? Recommendation: include redacted/truncated details for file mutation counts/diffs, but cap aggressively.
3. Should `tool-lens` skip ultra-fast tools if analyzer lags behind? Recommendation: still persist eventual analysis, but widget may show only active/latest N.
4. Should users be able to pause for one turn via shortcut/command? Recommendation: yes, `/tool-lens pause|resume|once`.
5. Should the core annotation API be part of the same issue or separate follow-up? Recommendation: separate issue linked from this one unless toggle is mandatory for v1.

## Implementation order

1. Scaffold `tool-lens` extension, config loader, README stub.
2. Implement redaction/truncation and tests first.
3. Implement state machine and fake event tests.
4. Implement custom-entry store and reconstruction tests.
5. Implement context/prompt builders and tests.
6. Implement analyzer streaming runner with fake stream tests.
7. Implement widget/status renderer.
8. Wire Pi events with fail-open behavior.
9. Add optional digest message renderer.
10. Add smoke docs and manual test notes.
11. Open a separate Pi core issue for tool annotations + raw/lens toggle if desired.
