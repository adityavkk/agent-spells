# recap

Pi extension that shows a one-line "here's where we left off" summary above the
editor when you return to an idle session. Step away mid-task for a few
minutes, tab back, and the recap is waiting: what was being worked on, where it
landed, what's next. Type anything and it disappears.

Modeled on Claude Code's Session recap (the "away summary"); the verified prior
art and design rationale live in `ideas/recap/recap-widget.md`. Display-only by
design: the recap never enters LLM context, never touches conversation history,
and never participates in compaction.

## Controls

- `/recap` — generate and show a recap immediately, bypassing every gate.
  Works even when the automatic recap is disabled.
- `--no-recap` — CLI flag; disables the automatic recap for this run.
- `PI_RECAP_ENABLED=0` — env var; disables the automatic recap.
- `"enabled": false` in `recap.json` — disables it persistently.
- Non-interactive mode (`pi -p`, RPC) never shows a recap.

## When the automatic recap fires

All of these must hold at once:

1. **3+ minutes since the last completed turn, and the terminal is unfocused**
   (`idleThresholdMs`). Generation runs in the background while you are away,
   so the recap renders the instant you tab back.
2. **The session has 3+ completed turns** (`minTurns`). A turn counts when the
   assistant stops normally; aborted and errored turns restart the idle clock
   but do not count. Short sessions stay recap-free.
3. **No recap has shown since the last activity** (`neverTwiceInARow`).
   Tabbing away twice without new activity shows nothing the second time.
4. **The editor is empty** (`suppressWhileComposing`). A half-typed prompt is
   never covered; display waits for the next return with an empty editor.

It never generates while the agent is streaming or while messages are queued.
Compaction and tree navigation abort any in-flight generation and invalidate
the cache (an epoch counter discards results that finish after the transcript
was rewritten), and tree navigation re-reads the turn gates from the branch
you navigated to. On resume, a recap persisted for the exact same transcript
is reused instead of regenerated.

### Focus detection and the fallback

Focus comes from DECSET 1004 terminal focus reporting. The extension enables it
at session start (`\x1b[?1004h`), strips the `\x1b[I` / `\x1b[O` reports out of
the input stream, and restores the terminal mode on shutdown — plus a
last-resort `process.on("exit")` restore for crash paths. The mode is
re-asserted (an idempotent no-op) whenever the idle timer arms, so a Ctrl+Z
suspend or an external-editor handoff that resets terminal modes heals itself.
Bracketed-paste chunks bypass focus parsing entirely, so pasted text containing
literal `\x1b[I` bytes is never corrupted.

Some environments never deliver focus reports (some tmux/screen setups, SSH
hops, minimal terminals). Until the first focus event arrives, the extension
treats focus as unknown and uses pure idle-timer behavior: after
`idleThresholdMs` of idle (same gates otherwise), the recap generates and shows
immediately. The first real focus event switches it to focus-edge behavior for
the rest of the session. Set `"trigger": "idle-timer"` to force the fallback;
set `"useFocusReporting": false` to never touch the terminal mode.

## Which model writes the recap

A cheap model resolved through `model-profiles`, role candidates
`recap → smol → small`. Define a `recap` role in `model-profiles.json` to pin
it; without one, the existing `smol`/`small` role applies (in the author's
active profile, `smol` resolves to `wibey-anthropic/claude-haiku-4-5-20251001`
— a Haiku-class background model, the same class Claude Code routes background
summaries to). The foreground model and thinking level are never touched.

Pin a model directly without touching roles:

```json
{
	"modelSelection": {
		"targets": [{ "provider": "wibey-anthropic", "model": "claude-haiku-4-5-20251001" }]
	}
}
```

By default the recap is incremental (`"summarizeMode": "delta"`): the previous
recap plus only the new activity goes to the model, so cost stays flat as
sessions grow. Compaction or tree navigation resets the delta base.

## Configuration

Global `~/.pi/agent/recap.json`, overridden per-project by `.pi/recap.json`.
Invalid values fall back to defaults; parse errors surface as warnings, never
crashes.

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Master switch for the automatic recap. |
| `idleThresholdMs` | `180000` | Idle time since the last completed turn before a recap can fire. |
| `minTurns` | `3` | Completed turns required before any recap. |
| `neverTwiceInARow` | `true` | Require fresh activity between automatic recaps. |
| `suppressWhileComposing` | `true` | Never display over unsent editor text. |
| `trigger` | `"focus-idle"` | `"focus-idle"` or `"idle-timer"`. Focus mode auto-falls back until a focus event is seen. |
| `useFocusReporting` | `true` | Enable DECSET 1004 at session start. |
| `modelSelection` | `{}` | model-profiles selection: `role`, `roleCandidates`, `targets`, `profile`, … |
| `maxInputTokens` | `12000` | Approximate cap on transcript tokens sent to the model. |
| `summarizeMode` | `"delta"` | `"delta"` folds new activity into the previous recap; `"full"` resummarizes everything. |
| `maxLines` | `1` | Widget height (panel style wraps up to this many lines). |
| `style` | `"line"` | `"line"` = single truncated line; `"panel"` = label row plus wrapped body. |
| `commandName` | `"recap"` | Slash-command name. Applied at extension load; restart pi after changing it (a warning appears when the loaded config disagrees with the registered name). |
| `prompt` | built-in | Replaces the summarization instructions. |
| `showContextGauge` | `false` | Append `ctx NN%` from current context usage. |
| `generationTimeoutMs` | `30000` | Abort generation after this long. Floor: 1000 — a zero timeout would wedge the in-flight guard on a hung provider. |
| `focusDebounceMs` | `250` | Minimum settle time added to the idle timer. |

## Failure behavior

The automatic path is fail-silent: no model available, auth missing, timeout,
provider error — the recap does not appear, and the prompt is never blocked.
A failed automatic generation retries at most once per idle period. `/recap`
is user-initiated, so it reports its errors via notify. Generation aborts hard
at `generationTimeoutMs`; results that arrive after the transcript moved on
are discarded, and teardown aborts any generation still in flight.

In idle-timer mode, a generated recap whose display is momentarily blocked (a
draft appeared mid-generation) is re-checked every few seconds at zero token
cost until it can show or the transcript moves on.

Each generated recap is persisted as a `custom` session entry
(`customType: "recap"`) for delta summarization across reloads; identical
back-to-back recaps are not re-persisted. Custom entries never enter LLM
context. The recap model is resolved against the live model-profiles
selection — a synthetic `profiles/<profile>:<role>` session model contributes
its profile and role, but is never itself used as the recap fallback (that
would route the recap through model-profiles' provider and mutate its
fallback state).

## Development

```bash
bun run test:recap        # 102 unit tests over the pure modules
bun run typecheck:recap   # strict tsc over the extension + its model-profiles imports
```

`trigger.ts` (state machine), `focus.ts` (1004 parsing), `transcript.ts`
(fingerprints, digests, delta cursors), `config.ts`, `summarize.ts`, and
`widget.ts` are pure and tested directly; `index.ts` wires them to the pi
extension API and owns every side effect (timers, terminal modes, widget
lifecycle, the staleness epoch).

The implementation was additionally audited for composition against every
other extension in this repo (widget keys, commands, flags, terminal-input
handling, custom entry types, model-profiles coupling) by a multi-agent
adversarial review; confirmed findings are fixed here, including two
pre-existing leader-key-standalone issues the audit surfaced.

Known limits: pi-tui's StdinBuffer flushes a partial escape sequence after
10ms of silence (affects all escape parsing in pi equally; accepted), and in
focus-idle mode a recap deferred by a draft retries on the next focus-in, not
the moment the draft is cleared. The recap widget renders above whatever
occupies the editor surface — including an open `/answer` questionnaire or
`/render` viewer — and clears on the next keystroke; pi exposes no "modal
active" signal to suppress it there.
