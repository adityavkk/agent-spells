# tool-lens

Pi extension that explains, in a streaming way, the **intent** of each tool call
(at call time) and the **outcome** (when it finishes), grounded in the current
session. It runs a cheap analyzer model as a sidecar to the main agent loop. It
never changes tool inputs/results and never blocks execution.

## Surfaces (hybrid)

Three layers, each used where the Pi API actually allows it:

- **Live HUD** during execution: a below-editor widget fed by an in-memory
  store. Intent appears while a tool runs; outcome appears as each tool finishes.
  Multi-row, one row per tool call, always in source order.
- **Persisted cards** at idle: at `agent_end` when the agent is idle, one
  consolidated `custom_message` card per analyzed tool call (source order).
  Durable, inline, expandable (ctrl+o), toggleable.
- **Hidden audit entries**: per-phase `custom` entries for crash/reload
  recovery. Never enter LLM context, never trigger a turn.

### Why hybrid

Appending a card to the transcript while the agent is streaming is queue-gated
and triggers an extra LLM turn. tool-lens therefore only flushes cards when the
agent is idle (`ctx.isIdle()` after `agent_end`), which adds no extra turn. The
HUD covers the live per-tool moment; cards provide permanence. True inline
streaming under each tool row needs a Pi core API (separate follow-up).

## How it works

- `tool_execution_start` (source order, upfront): seed the record, capture a
  redacted input snapshot, and queue an intent analysis. No model await here.
- `tool_execution_end` (completion order, per tool): capture a redacted output
  summary and request an outcome analysis. A fast tool streams while siblings
  still run.
- `agent_end` + idle: flush one card per analyzed call in source order; clear
  the HUD.
- `session_start`: rebuild state from the current branch (card `details`
  preferred, else latest audit phase), so reload/fork keep their lens.
- `context`: strip every tool-lens card from the messages sent to the LLM.

### Parallel tool calls

Intents fan out at start; outcomes stream per tool at end. Display is always
source order. Cost is bounded by one global batch semaphore
(`analysis.maxConcurrentAnalyses`) plus **late-merge**: if a tool ends before its
queued intent has started, a single combined intent+outcome call runs instead of
two. Beyond `limits.maxAnalysesPerTurn`, calls render as "not analyzed".

## Visibility

Three states `full | compact | hidden` for both HUD and cards, with no session
mutation:

- Shortcut: default `ctrl+l` (rebindable via `rendering.toggleShortcut`).
- Command: `/tool-lens [full|compact|hidden|toggle]` is always available.
- Per-card density follows the global ctrl+o expand/collapse.

> Note: `CustomMessageComponent` always prepends one blank line, so a `hidden`
> card is a one-line stub, not zero-height.

## Config

Global: `~/.pi/agent/tool-lens.json`
Project: `.pi/tool-lens.json` (project overrides global).

Env escape hatches:

- `PI_TOOL_LENS=0` disable entirely
- `PI_TOOL_LENS_RENDER=full|compact|hidden` override default visibility
- `PI_TOOL_LENS_HUD=0` disable the live HUD (cards only)
- `PI_TOOL_LENS_CARDS=0` disable persisted cards (HUD only)

```json
{
  "enabled": true,
  "mode": "intent-and-outcome",
  "tools": {
    "allowList": ["*"],
    "blockList": [],
    "aliases": { "shell_command": "bash", "apply_patch": "edit", "read_file": "read" }
  },
  "modelSelection": { "roleCandidates": ["tool-lens", "smol"] },
  "analysis": { "maxConcurrentAnalyses": 2, "lateMerge": true, "stream": true, "timeoutMs": 20000 },
  "context": { "maxMessages": 8, "maxChars": 12000, "includeSystemPrompt": false, "includeContextFiles": false, "includePriorToolResults": true },
  "capture": { "toolDetailsFor": ["edit", "apply_patch"] },
  "redaction": { "enabled": true, "redactEnvLikeValues": true, "onFailure": "skip", "extraPatterns": [] },
  "limits": { "maxInputChars": 4000, "maxOutputChars": 8000, "maxAnalysesPerTurn": 24 },
  "rendering": {
    "liveHud": true,
    "hudMaxRows": 8,
    "persistCards": true,
    "stripFromContext": true,
    "defaultVisibility": "full",
    "visibilityCycle": ["full", "compact", "hidden"],
    "toggleShortcut": "ctrl+l",
    "expandedByDefault": false
  }
}
```

Notes:

- `mode`: `intent-only | outcome-only | intent-and-outcome`.
- `tools.allowList`/`blockList`: matched after alias normalization; blocklist
  wins; `"*"` allows everything.
- `modelSelection`: explicit `provider`/`model` (or `targets`) win, then cheap
  roles `tool-lens`/`smol` resolved via model-profiles with model fallbacks off.
- `rendering.stripFromContext` must stay `true` so flushed cards never reach the
  LLM on the next turn.
- `redaction.onFailure: "skip"` marks a call `not_analyzed` instead of sending
  un-redactable content to the analyzer.

## Privacy / security

- Inputs and outputs are redacted and truncated before any model call,
  rendering, or persistence (env-like secrets, bearer tokens, auth headers, PEM
  private keys, provider key prefixes, long token-like blobs).
- Default `includeSystemPrompt=false` and `includeContextFiles=false`.
- The analyzer model receives no tools; auth comes from the model registry and
  keys are never printed.
- All analysis text lives in card `details` (which never enter context) and in
  hidden audit entries; card `content` stays empty so nothing leaks even if the
  context strip is bypassed.
- Retention is session-embedded only in v1; there is no cross-session disk log.
- Fail open for tool execution; fail safe for analyzer data collection.

## Manual smoke

```bash
pi --extension ./pi/extensions/tool-lens/index.ts
```

Prompts:

1. "Read README.md and summarize the repo."
2. "Run the tool-lens tests and explain any failure."
3. "Make a harmless edit then inspect git diff."
4. "Run two independent searches in parallel if possible."

Expect: intent in the HUD while the tool runs; outcome per tool as each
finishes; persisted cards in source order at idle that survive reload/fork; no
extra LLM turn from flushing; main tool execution never blocked by the analyzer.

## Tests

```bash
bun test pi/extensions/tool-lens
```

Covers config merge/env, redaction, tiered capture context, store reconstruction,
the semaphore + late-merge scheduler, the analyzer state machine, visibility,
HUD/card rendering, the idle-flush no-extra-turn gate, and prompt parsing.

## Deferred / follow-up

True inline streaming under each tool row and a generic raw/lens toggle need a Pi
core annotation/view-mode API (tracked as a separate core issue). Option C
(`renderResult` wrapper for built-ins/provider-profile tools) is also deferred.
