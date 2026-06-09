# Session recap widget for pi

A pi extension that surfaces a short "here's where we left off" recap above the
prompt when you come back to an idle session — modeled on Claude Code's
**Session recap** ("away summary") feature, but built on pi's extension API and
its cheap-model machinery.

## Why this matters

Long agent sessions lose you. You kick off a task, tab away to a meeting or a PR
review, come back twenty minutes later, and the last thing on screen is some
half-scrolled tool output. You have to scroll up and re-read to remember what
the agent was even doing.

Claude Code shipped a small, well-judged fix for this: when you step away and
come back, it shows a one-line recap of what's happened in the session so far,
right by the prompt. It's cheap, it's unobtrusive, and it triggers exactly when
it's useful — on return, not on a timer. I want the same thing in pi.

This doc captures (1) verified prior art on how Claude Code's feature actually
works, (2) what pi already gives us to build it, and (3) a concrete design:
user journeys, edge cases, config, and an implementation sketch.

---

## Prior art: Claude Code "Session recap"

All claims below were researched and adversarially verified against primary
sources (Anthropic docs + the `anthropics/claude-code` CHANGELOG, fetched
directly). Confidence is called out where it matters. References at the bottom.

### What it is

- Officially called **Session recap** (informally the "away summary"). The
  on-demand form is the **`/recap`** slash command; the env var is
  **`CLAUDE_CODE_ENABLE_AWAY_SUMMARY`**.
- The Interactive-mode docs describe it as *"a one-line recap of what happened
  in the session so far,"* shown in the terminal status area near the prompt
  **when you return to the terminal after stepping away**.
- It exists in **two forms**:
  1. **Automatic** — generated in the background while you're away, shown on
     return.
  2. **On-demand** — `/recap` generates a summary immediately, bypassing all the
     automatic trigger gating.
- **On by default** for every plan and provider; **always skipped in
  non-interactive mode** (`claude -p`, hooks, headless).
- It is a **display/status-line feature**, explicitly *distinct* from context
  management (`/compact`, auto-compact, microcompact). Recap does **not** mutate
  the conversation history — it is rendered output only. (Confirmed high.)

### Trigger mechanism — event/state edge, NOT a periodic timer

This was the key thing I got wrong at first. It is **not** "summarize every N
minutes." The automatic recap fires only when **all three** hold at once
(verbatim from the docs, confidence high):

1. **≥ 3 minutes have passed since the last completed turn AND the terminal is
   unfocused.** Generation happens in the *background while unfocused*, so the
   recap is ready with near-zero latency the instant you switch back.
2. **The session has ≥ 3 turns** of history (trivial sessions get nothing).
3. **Never twice in a row** — it won't show again without fresh activity in
   between.

So the "interval" a user perceives is really *"I tabbed away for 3+ minutes and
came back."* The `/recap` command is the manual escape hatch and ignores all of
the above.

Two shipped bug fixes reveal additional implicit guards (both high confidence,
from the CHANGELOG):

- **v2.1.113** — *"Fixed session recap auto-firing while composing unsent text
  in the prompt."* → it must **not** fire while you're mid-typing. Design this in
  from the start.
- **v2.1.110** — *"Fixed session recap … not appearing in focus mode"* → it
  shares the status-line/focus-mode rendering path with other near-prompt
  surfaces (task list, PR badge, prompt suggestions). Focus/idle detection is
  **client-side terminal state**.

### Which model? (inference, not documented)

- **Unconfirmed for the recap specifically.** Neither the docs nor any of the
  five recap-related CHANGELOG entries name the model. This silence is
  *meaningful* because the changelog names models elsewhere (a compaction
  preamble was changed to be *"generated deterministically instead of calling
  Haiku"*).
- **Strong inference: a Haiku-class background model.** Claude Code routes
  lightweight background work to `ANTHROPIC_DEFAULT_HAIKU_MODEL` (officially
  *"the model to use for haiku, or background functionality"*; the deprecated
  `ANTHROPIC_SMALL_FAST_MODEL` did the same). The costs docs list *"Conversation
  summarization: background jobs that summarize previous conversations for the
  `claude --resume` feature"* as a background-token task costing **typically
  under $0.04/session**.
- Rough cost gradient (per MTok in/out): **Haiku 4.5 ≈ $1 / $5**, Sonnet 4.6
  ≈ $3 / $15, Opus 4.8 ≈ $5 / $25 — i.e. a small model is ~3–5× cheaper, which is
  what keeps idle recap overhead negligible.
- Treat **"uses Haiku"** as a high-probability inference, not a documented fact.

### How it's (most likely) implemented

- **Background, speculative summarization of the live transcript**, computed
  while the terminal is unfocused so the result is **cached and ready on
  refocus**. Community write-ups describe it as *"running in the background,
  reusing the prompt cache, computationally minimal"* — consistent with the
  documented background-summarization path used for `claude --resume`, not the
  heavier auto-compact/microcompact path.
- **Display-only**: appended as command/status output, never replacing message
  history.

### How it relates to (and differs from) context management

| Feature        | Trigger                                  | Touches history? | Model call |
|----------------|------------------------------------------|------------------|------------|
| **Session recap** | focus + 3-min idle edge (or `/recap`) | **No** (display) | cheap/background |
| `/compact`     | manual                                   | **Yes** (9-section summary) | yes |
| auto-compact   | near context limit (`autoCompactThreshold ≈ contextWindow − 13000`; ~167K of 200K; tunable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) | **Yes** | yes |
| microcompact   | stale tool results (keeps ~last 5)       | **Yes** (trims tool results) | **no** |

The recap is the *cheap, transcript-summarizing, display-only* one. Keep it that
way in pi — do **not** couple it to context-trimming logic.

### Version history & community signal

- **v2.1.108** — introduced: *"Added recap feature to provide context when
  returning to a session, configurable in `/config` and manually invocable with
  `/recap`; force with `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` if telemetry disabled."*
  (Some blogs mis-cite v2.1.114; the changelog says 2.1.108.)
- **v2.1.110** — enabled for telemetry-disabled providers (Bedrock, Vertex,
  Foundry, `DISABLE_TELEMETRY`); opt out via `/config` or
  `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`; focus-mode rendering fix.
- **v2.1.113** — fixed auto-firing while composing unsent text.
- **Community feedback worth heeding:** a `/recap` command shadowing users'
  `/r → /review` muscle memory was a real complaint (avoid namespace
  collisions); a docs-gap issue (#48084) was filed because controls shipped
  undocumented (document the command + toggle + env var up front). Codex shipped
  a similar "recap" too, so the pattern is converging across harnesses.

### What's genuinely unknown (don't overfit)

- The exact model.
- Exact rendering format / placement ("one-line" is the only documented detail;
  "single line above the input box" and the example wording come from a
  third-party blog — unverified whether it wraps).
- The exact summarization prompt, and whether it summarizes the **full
  transcript** or only the **delta since the last recap**.
- How focus/unfocus is detected across emulators/multiplexers (tmux, screen,
  SSH, terminals without focus reporting) — the v2.1.110/v2.1.113 fixes imply
  it's non-trivial and emulator-dependent.
- Whether automatic and `/recap` share the same path/model.
- Whether a "turn" means a user+assistant pair or individual messages.

---

## What I want to build for pi

A **`recap`** extension that:

- Renders a short recap **in a widget above the prompt** when you return to an
  idle, unfocused session — and on demand via **`/recap`**.
- Generates the summary with a **cheap, fast model** resolved through the
  existing `model-profiles` machinery (a dedicated `recap` role, falling back to
  `small`/`smol`), so idle overhead stays cheap.
- Is **display-only** — it appends a non-LLM-visible entry for persistence and
  never touches the conversation context.
- Ships with the trigger gating, controls, and docs from day one, learning from
  Claude Code's bug fixes rather than re-discovering them.

---

## What pi already gives us

Grounded in the installed `@mariozechner/pi-coding-agent` types
(`node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`)
and the existing extensions in this repo. The building blocks already exist:

### The render surface — `setWidget` with `aboveEditor` placement

```ts
// ExtensionUIContext
setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
setWidget(key: string, content: ((tui, theme) => Component & { dispose?(): void }) | undefined, options?): void;
// ExtensionWidgetOptions { placement?: WidgetPlacement }  // defaults to "aboveEditor"
```

This is an exact match for "a recap above the text box." Plain `string[]` covers
the one-liner; the component-factory form lets us theme it (dim label + accent
text) and add a keybinding hint. `setWidget(key, undefined)` clears it.

(`floating-composer` already owns the editor surface via
`ctx.ui.setEditorComponent`; a `setWidget("recap", …, { placement: "aboveEditor" })`
renders above that panel, so the two compose cleanly.)

### Lifecycle events to drive the trigger

From the `ExtensionAPI.on(...)` overloads — the relevant ones:

- `turn_end` / `agent_end` — mark "last completed turn" time; count turns for the
  ≥3-turn gate.
- `turn_start` / `message_start` — fresh activity → reset the "never twice in a
  row" latch and clear a stale recap.
- `session_compact` / `session_before_compact` — context was rewritten; the next
  recap should regenerate rather than reuse a cached pre-compaction summary.
- `session_start` / `session_shutdown` — wire up / tear down timers and focus
  reporting.
- `input` — observe user input (supplements editor-text checks).

### Focus + idle detection

pi has **no built-in blur/focus event**, so we detect it ourselves:

- `ctx.ui.onTerminalInput(handler)` — raw terminal input (interactive only),
  returns an unsubscribe fn. Enable **DECSET 1004** focus reporting
  (`\x1b[?1004h`) and watch for **`\x1b[I`** (focus-in) / **`\x1b[O`**
  (focus-out). This is exactly the client-side terminal state Claude Code relies
  on.
- **Fallback when 1004 is unsupported** (tmux/screen/SSH/dumb terminals): degrade
  to a pure **idle timer** measured from the last `turn_end` — show the recap the
  next time the user submits/interacts after ≥ N minutes idle. Less elegant, but
  it works everywhere.
- `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.signal` — only generate when
  the agent isn't streaming and nothing is queued.

### "Don't fire while composing"

- `ctx.ui.getEditorText()` — if non-empty, suppress (this is the v2.1.113 fix,
  designed in up front).

### Reading the transcript

- `ctx.sessionManager.getEntries()` + `getLeafId()` → `buildSessionContext(entries, leafId)`
  returns `{ messages, thinkingLevel }` (both footer extensions already use
  this).
- `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }` — optional
  secondary trigger / to show "ctx 62%" alongside the recap.
- `pi.appendEntry(customType, data)` — persist the recap text + the last-summarized
  entry id **without** sending it to the LLM. Enables incremental summarization
  and survival across renders.

### The cheap model call

- `streamSimple(model, context, options)` from `@mariozechner/pi-ai`
  (`StreamFunction = (model, context, options?) => AssistantMessageEventStream`),
  exactly as `model-profiles/provider.ts` uses it.
- `resolveExtensionExtractionModel({ modelRegistry, config, currentModel, selection, defaultRoleCandidates })`
  from `model-profiles/extension-resolver` — this is how `render`/`answer` pick a
  small model today. Add a `recap` role with candidates `["recap", "small", "smol"]`.
- Optional: BAML for a structured `{ recap, headline, files[], nextStep }` (like
  `answer`/`render`), but a plain text completion is simpler for v1.

### Discoverability & control

- `pi.registerCommand("recap", …)` — on-demand recap. Handler gets
  `ExtensionCommandContext` (adds `waitForIdle()`, etc.).
- `pi.registerShortcut(keyId, { handler })` — e.g. dismiss / expand-to-detail.
- `pi.registerFlag("no-recap", { type: "boolean" })` + `pi.getFlag(...)` — CLI
  opt-out, mirroring `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`.
- Per-repo config file like `answer`/`render` (`config.ts`).

**Net:** every primitive exists. This is plumbing + good defaults, not new
core capability — the same conclusion the `resume-subagents` idea reached about
its feature.

---

## Trigger design (concrete)

State machine, evaluated on events + a light timer:

```
states: IDLE_WATCH → (blur + idle≥T + ≥minTurns + editor empty + not-just-shown) → GENERATING → READY → (focus-in) → SHOWN
```

1. On `turn_end`: record `lastTurnEndAt`, increment `turnCount`, clear any shown
   recap, reset the not-twice latch (fresh activity happened).
2. On focus-out (`\x1b[O`) **or** when 1004 is unavailable, arm a timer for `T`
   (default 3 min) from `lastTurnEndAt`.
3. When the timer fires AND `turnCount ≥ minTurns` AND `getEditorText()` is empty
   AND `isIdle()` AND no recap was shown without intervening activity →
   **generate in the background** with the cheap model. Cache the result keyed by
   `leafId` + last entry id.
4. On focus-in (`\x1b[I`) — or, in fallback mode, on the next user interaction —
   if a cached recap exists, render it via `setWidget`. Set the not-twice latch.
5. On any `turn_start`/`message_start`/`input` with text → clear the widget and
   the latch.

`/recap` jumps straight to step 3's generation + step 4's render, ignoring all
gates.

**Recommendation:** trigger on the focus+idle *edge*, never a bare periodic
timer — a timer-based recap is noisy and Claude Code deliberately avoided it.

---

## User journeys

1. **Step away and return (the core one).** You start a refactor, the agent runs
   for a few turns, you tab to Slack. Three minutes later you tab back; above the
   prompt: *"Recap: migrating `auth/` to JWT — edited 4 files, token-expiry tests
   still failing. Next: fix `verifyExpiry()`."* You're oriented in one glance, no
   scrolling. You type and the recap clears.

2. **On-demand mid-session.** You're deep in a long session and lose the thread.
   You type `/recap` and immediately get a summary, without tabbing away.

3. **Short session, no noise.** Two-turn "what does this regex do" session — you
   tab away and back; **no recap** (under the 3-turn floor). The feature stays
   invisible until it's worth it.

4. **Came back, nothing changed.** You glance away for 20s, come back; no
   3-minute idle elapsed → no recap. You tab away again right after a recap
   showed; it does **not** show twice without fresh activity.

5. **Mid-typing.** You half-typed a long prompt, then got distracted reading
   docs in the same pane. The recap does **not** clobber your draft (editor-text
   guard).

6. **Headless / CI.** `pi -p "…"` or a hook-driven run → recap fully skipped.

7. **Power user, custom model.** Sets a `recap` role in `model-profiles` to a
   local/cheap model; recaps run there, foreground coding model untouched.

8. **Resume after compaction.** auto-compact rewrote the context; the next recap
   regenerates from the post-compaction transcript instead of showing a stale
   pre-compaction summary.

---

## Edge cases (and how to handle them)

- **Composing unsent text** → suppress while `getEditorText()` is non-empty
  (Claude Code v2.1.113). On focus-in with a draft present, defer until the
  editor is empty again.
- **No focus-reporting support** (tmux/screen/SSH/dumb term) → fall back to
  idle-since-`turn_end` timer; never assume `\x1b[I/O` arrives. Always restore
  terminal state (`\x1b[?1004l`) on `session_shutdown`.
- **Agent still streaming when timer fires** → gate on `ctx.isIdle()` and
  `!hasPendingMessages()`; don't summarize a half-finished turn.
- **Rapid focus flapping** (alt-tab spam) → debounce focus events; only one
  in-flight generation; cache by transcript fingerprint so flapping doesn't
  re-spend tokens.
- **Generation fails / model unauthorized / times out** → fail silent: no widget,
  log at debug, optional one-time `ctx.ui.notify(...)`. Never block the prompt.
  Apply a short timeout + `AbortController` (the footer extensions already use
  this pattern).
- **Generation outlives the session/turn** (user returns and submits before it
  finishes) → drop the stale result; discard if `leafId` changed.
- **Compaction / tree navigation mid-flight** → invalidate cache on
  `session_compact` / `session_tree`; key the cache on `leafId` + last entry id.
- **Multiple footer/composer extensions active** → use a unique widget key
  (`"recap"`); `aboveEditor` placement composes with `floating-composer`.
- **Very long / very short transcripts** → cap input tokens sent to the cheap
  model (truncate-head, keep recent turns + first user message); if under the
  turn floor, show nothing.
- **Secrets in transcript** → the recap is generated by a model and rendered
  locally; don't write it anywhere new beyond the session file. Respect the same
  trust boundary as the conversation itself.
- **Widget eating vertical space** → keep it to 1 line by default (`maxLines`
  config); truncate with width-aware helpers (`truncateToWidth`/`visibleWidth`
  from `pi-tui`, already used here).
- **Command namespace collision** → `/recap` is fairly safe, but verify against
  `pi.getCommands()` and allow a configurable command name (learn from the
  `/r → /review` complaint).
- **Theme/contrast** → render via the component factory using theme tokens
  (`theme.fg("dim", …)`, `theme.fg("accent", …)`), like the footer extensions.

---

## Configuration parameters

Per-repo config (`recap/config.ts`, loaded like `answer`/`render`), with env +
flag overrides:

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch (mirrors `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`). |
| `idleThresholdMs` | number | `180000` (3 min) | Idle-since-last-turn before arming. |
| `minTurns` | number | `3` | Minimum completed turns before any recap. |
| `neverTwiceInARow` | bool | `true` | Require fresh activity between recaps. |
| `suppressWhileComposing` | bool | `true` | Skip if editor has unsent text. |
| `trigger` | `"focus-idle" \| "idle-timer"` | `"focus-idle"` | Edge vs. fallback timer. |
| `useFocusReporting` | bool | `true` | Enable DECSET 1004; auto-fallback if unsupported. |
| `modelSelection` | object | `{}` | `model-profiles` selection; role candidates `["recap","small","smol"]`. |
| `maxInputTokens` | number | `~12000` | Cap transcript tokens sent to the cheap model. |
| `summarizeMode` | `"full" \| "delta"` | `"delta"` | Whole transcript vs. only since last recap. |
| `maxLines` | number | `1` | Widget height; >1 allows wrap/detail. |
| `style` | `"line" \| "panel"` | `"line"` | Plain `string[]` vs. themed component. |
| `commandName` | string | `"recap"` | Slash command name (collision-avoidance). |
| `prompt` | string | built-in | Override the summarization instructions. |
| `showContextGauge` | bool | `false` | Append `ctx NN%` from `getContextUsage()`. |

Overrides: `PI_RECAP_ENABLED=0`, CLI `--no-recap` (`pi.registerFlag`).
Non-interactive mode (`!ctx.hasUI`) always disables, no config needed.

---

## Implementation sketch

```
pi/extensions/recap/
  index.ts        # extension entry: events, focus reporting, widget render, /recap command, shortcut
  trigger.ts      # focus+idle state machine; turn counting; latches; debounce
  summarize.ts    # build context from transcript (delta or full), call streamSimple on cheap model
  model-selection.ts  # resolveExtensionExtractionModel with ["recap","small","smol"] (mirror render/)
  config.ts       # config schema + load (mirror answer/render config.ts)
  render.ts       # string[] line OR themed component factory for setWidget
  README.md
```

Skeleton:

```ts
export default function recapExtension(pi: ExtensionAPI) {
  const state = createTriggerState();           // lastTurnEndAt, turnCount, latch, cache
  let unsubInput: (() => void) | null = null;

  pi.on("session_start", async (_e, ctx) => {
    if (!ctx.hasUI || !config(ctx).enabled) return;
    if (config(ctx).useFocusReporting) enableFocusReporting();          // \x1b[?1004h
    unsubInput = ctx.ui.onTerminalInput((data) => onFocusBytes(data, ctx, state));
  });

  pi.on("turn_end", (_e, ctx) => {
    state.lastTurnEndAt = nowFromCtx(ctx);       // avoid Date.now in pure paths; use a clock seam
    state.turnCount++;
    clearRecapWidget(ctx); state.latch = false;  // fresh activity
    armIdleTimer(ctx, state);
  });

  pi.on("turn_start", (_e, ctx) => clearRecapWidget(ctx));
  pi.on("session_compact", () => state.cache.invalidate());
  pi.on("session_shutdown", () => { disableFocusReporting(); unsubInput?.(); });

  pi.registerCommand("recap", { description: "Summarize the session so far",
    handler: async (ctx) => { await generateAndShow(ctx, state, { force: true }); } });

  // generateAndShow: gate (idle, minTurns, editor empty, not-twice) unless force;
  //   resolve cheap model; build context (delta|full, capped); streamSimple with AbortController + timeout;
  //   cache by leafId+lastEntryId; setWidget("recap", lines, { placement: "aboveEditor" });
  //   pi.appendEntry("recap", { text, lastEntryId }).
}
```

Two pi-specific subtleties worth designing for:
- **`turn_end` vs. focus-in ordering.** Generate on the idle edge (background),
  render on focus-in, so the recap is ready with no latency — exactly Claude
  Code's speculative model.
- **Incremental (`delta`) summarization.** Store `lastRecappedEntryId` via
  `appendEntry`; summarize only entries since then and fold into the prior
  recap. Cheaper, and closer to "what changed while I was gone."

---

## Caveats

- **Focus detection is the hard part.** DECSET 1004 isn't universal; tmux needs
  pass-through, some terminals never send `\x1b[I/O`. The idle-timer fallback
  must be solid — and we must always restore terminal modes on shutdown.
- **The model is an inference, not a copy.** We don't actually know Claude Code's
  recap model. We make our own choice (cheap role via `model-profiles`) — which
  is arguably better, since it's explicit and user-tunable.
- **Don't gold-plate v1.** A one-line, focus+idle recap with `/recap`, the four
  guards, and a cheap model is the whole win. Panels, multi-line detail, and
  context gauges are nice-to-haves behind config.
- **Stay display-only.** The single most important boundary: never let the recap
  mutate conversation history or get entangled with compaction. (Mirrors the
  AGENTS.md boundary discipline for provider-tool sync.)

## Bottom line

Claude Code's Session recap is a small, sharp feature: summarize on the
**focus + idle edge**, gate hard against noise, render one line by the prompt,
run it on a **cheap background model**, keep it **display-only**. Every piece it
needs already exists in pi —  `setWidget({ placement: "aboveEditor" })`, the
lifecycle events, `onTerminalInput` for focus, `streamSimple` +
`model-profiles` for the cheap call, `appendEntry` for persistence,
`registerCommand` for `/recap`. The work is trigger logic + good defaults +
shipping the controls and docs together. Very feasible.

---

## References

### Claude Code (prior art) — primary
- Interactive mode (Session recap section): https://code.claude.com/docs/en/interactive-mode
- CHANGELOG (v2.1.108 intro, .110 telemetry+focus fix, .113 composing fix): https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Costs (background summarization, <$0.04/session): https://code.claude.com/docs/en/costs
- Env vars / model config (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, deprecated `ANTHROPIC_SMALL_FAST_MODEL`): https://code.claude.com/docs/en/env-vars · https://code.claude.com/docs/en/model-config
- Prompt caching: https://code.claude.com/docs/en/prompt-caching.md
- Compaction (platform): https://platform.claude.com/docs/en/build-with-claude/compaction
- Haiku 4.5 announcement / pricing: https://www.anthropic.com/news/claude-haiku-4-5
- What's new (Week 17 digest): https://code.claude.com/docs/en/whats-new

### Claude Code — community / corroborating
- Issue #34610 (community `/recap` request, closed not-planned/stale): https://github.com/anthropics/claude-code/issues/34610
- Issue #48084 (docs gap for `/recap` + away-summary controls): https://github.com/anthropics/claude-code/issues/48084
- Issue #48863 (v2.1.110 changelog line, product-docs omission): https://github.com/anthropics/claude-code/issues/48863
- wmedia.es session-recap writeup: https://wmedia.es/en/tips/claude-code-session-recap-resume-context
- claudefa.st session memory mechanics: https://claudefa.st/blog/guide/mechanics/session-memory
- Reverse-engineering refs: https://github.com/Yuyz0112/claude-code-reverse · https://www.reidbarber.com/blog/reverse-engineering-claude-code
- Compaction deep dive: https://decodeclaude.com/compaction-deep-dive/

### pi API (build target) — local
- Extension types (`setWidget`/`ExtensionWidgetOptions`, events, `ExtensionContext`, `getContextUsage`): `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
- `streamSimple` / `StreamFunction`: `node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/types.d.ts`
- Cheap-model resolution precedent: `pi/extensions/render/model-selection.ts`, `pi/extensions/model-profiles/extension-resolver.ts`
- Model call precedent (`streamSimple`): `pi/extensions/model-profiles/provider.ts`
- Above-prompt rendering precedent: `pi/extensions/floating-composer/index.ts` (`setEditorComponent`), `pi/extensions/floating-footer/index.ts` (`setFooter`)
- Config + BAML precedent: `pi/extensions/answer/`, `pi/extensions/render/`

### Research provenance
- Findings produced by a dynamic research workflow (multi-modal web sweep →
  adversarial verification against primary sources → synthesis). Run ID
  `wf_aa0f0bcc-66b`. Load-bearing claims confirmed against Anthropic docs and
  the `anthropics/claude-code` CHANGELOG fetched directly; the recap *model* and
  exact *rendering format* remain officially unconfirmed (see "What's genuinely
  unknown").
