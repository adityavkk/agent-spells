# GitHub issue draft: streaming tool-call analyzer extension

## Title

feat(pi): add streaming tool-call intent/outcome analyzer sidecar extension

## Problem

Pi shows tool calls and results, but users still have to infer:

- why the agent called this tool now
- what the agent expected to learn or change
- whether the result matched that intent
- what changed in the session after the tool finished

This gets harder when tools run in parallel, outputs are long, or the agent calls provider-native aliases (`shell_command`, `apply_patch`, `read_file`, etc.).

## Proposal

Add a new `tool-analyzer` Pi extension that observes main-agent tool calls without mutating them and runs a separate analyzer model as a sidecar.

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

The analyzer must work in parallel with the main agent loop: fail open, avoid blocking tool execution, and never change tool inputs/results.

## Pushback / important constraint

Pi's current public extension API supports live widgets/status updates and persisted custom messages. I did not find a public API for streaming updates into a custom transcript message exactly like assistant token streaming.

So v1 should either:

- implement live streaming in a sidecar widget (`ctx.ui.setWidget`) and persist the final analysis as a custom message, or
- first add a small Pi core API for extension-owned streaming transcript entries.

If the requirement is literally "same transcript stream affordance as the main assistant/tool loop", this is probably a Pi core improvement, not extension-only.

## User value

- Better operator trust: see intention before dangerous or confusing calls complete.
- Better debugging: correlate inputs, outputs, and session goal without reading raw logs.
- Better parallel-tool visibility: understand sibling tool calls as separate work items.
- Better onboarding: new Pi users can learn what the agent is doing without interrupting it.

## Non-goals

- Do not ask the analyzer to approve/block tools. That is a separate permission extension.
- Do not mutate tool inputs or results.
- Do not expose secrets, raw environment values, or unredacted large outputs to the analyzer model.
- Do not require BAML for v1 unless structured extraction becomes necessary.
- Do not replace built-in tool rendering in v1.

## UX sketch

Live widget, below editor by default:

```text
Tool analyzer

[1] shell_command  running  2.1s
Input: bun test pi/extensions/render/config.test.ts
Intent: Verify the render config parser after changing merge behavior.
Expected outcome: Tests pass, or failures point at normalization/merge regressions.
Risk: Unit-only; does not verify live model selection.

Outcome: Passed. Confirms config behavior for the edited cases. No runtime smoke yet.

[2] apply_patch  done
Input: pi/extensions/render/config.ts
Intent: Update config defaults while preserving project-over-global precedence.
Outcome: Patch applied cleanly. Likely changed only normalization/merge code.
```

Persisted custom message after turn, collapsed by default:

```text
Tool analysis: 4 calls, 3 matched intent, 1 error
```

Expanded message shows per-tool intent/outcome details with redacted inputs and output summaries.

## Declarative config

Config files:

- global: `~/.pi/agent/tool-analyzer.json`
- project: `.pi/tool-analyzer.json`

Project overrides global. Env escape hatches:

- `PI_TOOL_ANALYZER=0` disables
- `PI_TOOL_ANALYZER_RENDER=widget|transcript|off` overrides render surface

Suggested schema:

```json
{
  "enabled": true,
  "mode": "intent-and-outcome",
  "tools": {
    "include": ["*"],
    "exclude": [],
    "aliases": {
      "shell_command": "bash",
      "run_shell_command": "bash",
      "read_file": "read",
      "apply_patch": "edit"
    }
  },
  "modelSelection": {
    "roleCandidates": ["tool-analyzer", "small", "smol"],
    "useActiveProfile": true,
    "fallbackToActiveRole": true,
    "fallbackToDefaultRole": false
  },
  "analysis": {
    "promptStyle": "concise",
    "maxIntentBullets": 4,
    "maxOutcomeBullets": 5,
    "includeRisks": true,
    "includeNextStepImplication": true,
    "stream": true,
    "timeoutMs": 20000,
    "maxConcurrentAnalyses": 2
  },
  "context": {
    "maxMessages": 8,
    "maxChars": 12000,
    "includeSystemPrompt": false,
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
    "showRawInputs": "redacted-collapsed",
    "showRawOutputs": "summary-only",
    "groupParallelTools": true,
    "order": "assistant-source",
    "persistFinalMessage": true,
    "expandedByDefault": false
  },
  "privacy": {
    "sendInputsToAnalyzer": true,
    "sendOutputsToAnalyzer": true,
    "requireExplicitEnableForShellOutput": false,
    "localModelOnly": false
  }
}
```

Config notes:

- `mode`: `intent-only | outcome-only | intent-and-outcome`.
- `rendering.surface`: v1 supports `widget | status | off`; `transcript` needs core streaming-message support unless added first.
- `privacy.requireExplicitEnableForShellOutput`: if true, shell outputs are only locally summarized by heuristics unless project config opts in.
- Analyzer model should receive no tools in its context.

## Architecture plan

### Files

Create `pi/extensions/tool-analyzer/`:

- `index.ts`: Pi extension entrypoint and event wiring.
- `config.ts`: load/normalize/merge global + project config, env overrides.
- `types.ts`: config, state machine, analysis result types.
- `model-selection.ts`: reuse model-profile resolver pattern from `render`.
- `context.ts`: build compact session/tool context for analyzer prompts.
- `redaction.ts`: redact/truncate tool inputs/results before render/model calls.
- `prompts.ts`: intent and outcome prompt builders.
- `analyzer.ts`: streaming model runner, queue, cancellation, retries/timeouts.
- `renderer.ts`: widget/status renderer and custom message renderer.
- `README.md`: install, config, smoke prompts, privacy warnings.
- `*.test.ts`: config, redaction, context builder, state machine, renderer.

### Event flow

Use Pi extension events documented in `docs/extensions.md`:

- `session_start`: load config, restore persisted state if needed, register message renderer, initialize widget/status.
- `before_agent_start`: capture current user prompt and system-prompt metadata summary, not full system prompt by default.
- `turn_start`: initialize per-turn state.
- `tool_execution_start` or `tool_call`: create tool record with `toolCallId`, tool name, args, source order, timestamp.
  - Important: if using `tool_call`, return immediately; never await analyzer model there because `tool_call` can block execution.
  - Kick off intent analysis with `void queueIntentAnalysis(...)`.
- `tool_execution_update`: record optional partial result metadata, update render state only.
- `tool_result`: capture final content/details/isError and kick off outcome analysis.
  - Return `undefined`; never patch result.
- `tool_execution_end`: finalize duration/error metadata.
- `turn_end`/`agent_end`: persist final custom message if configured.
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
- Preserve assistant source order for display, but allow completion-order updates.
- Analyzer failure never fails the main agent turn.
- Backpressure: max concurrent analyzer model streams, queue or skip older/lower-priority calls.

### Analyzer prompt contract

Intent prompt returns concise Markdown. It must answer:

- `Intent`: what the tool call is trying to accomplish.
- `Why now`: what session context makes this call useful.
- `Expected outcome`: what useful result would look like.
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

### Rendering plan

V1 extension-only rendering:

- Use `ctx.ui.setWidget("tool-analyzer", ...)` for live streaming.
- Use `ctx.ui.setStatus("tool-analyzer", ...)` for compact progress/counts.
- Use `pi.registerMessageRenderer("tool-analysis", ...)` for persisted final analysis messages.
- Use `pi.sendMessage({ customType: "tool-analysis", display: true, details })` after `agent_end` or `turn_end`.

Optional Pi core follow-up:

- Add extension API for mutable/streaming custom transcript entries, e.g.:
  - `pi.startMessageStream(customType, initial, options)`
  - `stream.update(partial)`
  - `stream.end(final)`
- Then set `rendering.surface = "transcript"` to show analyzer output inline near each tool call.

### Privacy/security

- Redact before both model prompt and rendering.
- Never log raw tool inputs/outputs by default.
- Avoid env dumps, token-like strings, auth headers, `.env` content, private keys.
- Default `includeSystemPrompt=false`.
- Default output truncation with visible truncation metadata.
- Analyzer model auth uses `ctx.modelRegistry.getApiKeyAndHeaders`; never print keys.
- Fail closed for analyzer data collection if redaction throws, but fail open for main tool execution.

### Testing plan

Unit tests:

- Config normalization/merge/env overrides.
- Tool include/exclude/alias matching.
- Redaction for env vars, API-key-like tokens, private key blocks, auth headers.
- Input/output truncation metadata.
- Session context builder from fake branch entries.
- Prompt builders include required fields and omit raw system prompt by default.
- State machine handles interleaved parallel tool events.
- Queue respects concurrency, timeout, cancellation.
- Renderer produces stable collapsed/expanded text.

Manual smoke:

```bash
pi --extension ./pi/extensions/tool-analyzer/index.ts
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
- Redacted/truncated inputs/outputs appear in UI and persisted details.

## Acceptance criteria

- [ ] New `pi/extensions/tool-analyzer/` extension can be loaded directly by Pi.
- [ ] Declarative config loads from global and project paths, project wins, env can disable.
- [ ] Analyzer observes all configured tool calls across built-in and provider-tool-profile names.
- [ ] Intent analysis starts on tool call start without awaiting model completion in blocking hooks.
- [ ] Outcome analysis starts after final tool result.
- [ ] Live widget/status updates stream analyzer text while the main agent loop continues.
- [ ] Final per-turn analysis can be persisted as a custom message with custom renderer.
- [ ] Configurable model selection supports a `tool-analyzer` role and safe fallback.
- [ ] Inputs/outputs are redacted and truncated before analyzer model calls and before persistence.
- [ ] Parallel tool calls render deterministically and tolerate interleaved updates.
- [ ] Analyzer errors/timeouts are visible but never fail or mutate the main tool call.
- [ ] Unit tests cover config, redaction, context building, state transitions, and queue behavior.
- [ ] README documents config, privacy implications, and smoke prompts.

## Open grill questions

These should be answered before implementation hardens the issue:

1. Primary surface: do you need transcript-inline streaming, or is a live sidecar widget acceptable for v1?
2. Persistence: should final analysis become part of the session transcript by default, or be ephemeral unless toggled?
3. Cost/latency: analyze every tool call, or only slow/destructive/error-prone/long-output calls by default?
4. Model: should analyzer default to active model-profile role `tool-analyzer`, active main model, local model, or explicit provider/model?
5. Privacy: are raw shell outputs allowed to leave the machine for analyzer calls, after redaction/truncation?
6. Context: should analyzer see only recent visible messages, or also system prompt/AGENTS/tool descriptions?
7. Tone: terse operator notes, educational explanation, risk-audit style, or debug log style?
8. Outcome strictness: should analyzer judge whether the agent made a good decision, or only describe result vs intended outcome?
9. Parallel display: group sibling tool calls under one assistant turn, or independent chronological cards?
10. Controls: need `/tool-analyzer pause`, per-turn toggle, or per-tool ignore controls?
11. Data retention: store analyzer outputs in session details, separate `.pi` logs, both, or neither?
12. Redaction failures: skip analysis for that tool, or send a heavily minimized payload?
13. Tool outputs: summarize full output, only visible truncated output, or details object too?
14. Evaluation: what is the success metric: comprehension, reduced interruptions, safer shell use, debugging speed?
15. Name: `tool-analyzer`, `intent-lens`, `tool-lens`, or something else?

## Implementation order

1. Scaffold extension, config loader, README stub.
2. Implement redaction/truncation and tests first.
3. Implement state machine and fake event tests.
4. Implement context/prompt builders and tests.
5. Implement analyzer streaming runner with fake stream tests.
6. Implement widget/status renderer.
7. Wire Pi events with fail-open behavior.
8. Add persisted custom message renderer.
9. Add smoke docs and manual test notes.
10. If transcript-inline streaming is mandatory, open/implement Pi core streaming custom-message API first.
