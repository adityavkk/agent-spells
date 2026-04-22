# floating-layout

Opencode-style full-viewport layout for pi **as a pure extension**.

Owns the entire live viewport while active:

```
┌──────────────────────────┬────────────────────────────────────────────┬─┐
│ sidebar                  │ chat viewport                              │ │
│                          │  (scrollable, sticky-scroll-to-bottom)     │ │
│                          │                                            │ │
│  pi                      │  ▎ you                                     │█│
│                          │    make a note about X                     │█│
│  session                 │                                            ││ │
│    12 entries            │  ▎ assistant                               ││ │
│                          │    sure, I'll add it to second-brain.      ││ │
│  model                   │                                            ││ │
│    anthropic/claude-...  │  ▎ tool: Write                             ││ │
│                          │    path: .../inbox/x.md                    ││ │
│                          │                                            ││ │
│  keys                    │                                            ││ │
│   PgUp/PgDn scroll       │                                            ││ │
│   End stick to bottom    │                                            ││ │
│   Esc clear / exit       │                                            ││ │
├──────────────────────────┴────────────────────────────────────────────┴─┤
│ > type your prompt here                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## How it works

Pi exposes `ctx.ui.setEditorComponent(factory)` which replaces the composer
component. Nothing constrains that component's size, so this extension returns
one that fills `terminalHeight` rows. Pi's built-in `chatContainer` still
renders above; it's pushed entirely into terminal scrollback and never
appears in the live viewport because our editor covers the whole screen.

Event subscriptions (`message_start/update/end`, `tool_execution_start/end`)
rebuild a flat in-memory chat buffer that the layout renders inside its own
viewport pane.

`onSubmit` is preserved by pi's `setCustomEditorComponent` plumbing — typing
+ Enter still submits to the agent.

No monkey-patching. No alt-screen. No fight with pi-tui's renderer.

## Current status (MVP)

**Works:**

- Full-viewport takeover when toggled on (`/layout on`).
- Fixed sidebar on the left (hidden on terminals narrower than 100 cols).
- Scrollable chat viewport with a unicode scrollbar on the right.
- Sticky-scroll-to-bottom when new messages arrive and you're already at the
  bottom.
- Pi's composer (editor + autocomplete + paste + onSubmit) at the bottom.
- Backfill of chat buffer from existing session entries on resume/fork.

**Not yet:**

- Reuses plain-text rendering for messages. Phase 2 will plug in pi-tui's
  `Markdown` / `AssistantMessageComponent` for rich rendering, diffs, code
  highlighting.
- No session picker or model picker in the sidebar (static labels only).
- Images in chat aren't laid out horizontally (they'd clash with the sidebar
  column). Images currently appear as `[image]` placeholders.
- No keybinding to focus/unfocus the chat viewport (all scroll keys always
  route here; typing always routes to composer).

## Usage

```text
/layout         — toggle
/layout on      — activate
/layout off     — deactivate (restores pi's default editor; floating-composer
                  will NOT come back until you reload pi)
```

Scroll keys (while layout is active):

- `PgUp` / `PgDn` — scroll by 10 lines
- `Shift+PgUp` / `Shift+PgDn` — scroll by 30 lines
- `Ctrl+Home` — scroll to top
- `End` / `Ctrl+End` — stick to bottom (follow new messages)

## Conflict with `floating-composer`

Both extensions call `ctx.ui.setEditorComponent(...)`. Whichever runs last
wins. For a clean experience, disable one in home-manager:

```nix
# ~/.config/home-manager/home/pi/disabled-agent-spells-extensions.nix
[
  "floating-composer"   # use floating-layout instead
]
```

Then run `hmr fast`.

## Roadmap

- **Phase 2:** swap plain-text renderer for pi-tui `Markdown` per message; use
  `AssistantMessageComponent` style headers; handle tool diffs.
- **Phase 3:** sidebar content — session list picker, model picker, recent
  tool calls.
- **Phase 4:** focus model (tab between chat + composer); in-chat search.
- **Phase 5:** optionally monkey-patch `AssistantMessageComponent.prototype.render`
  to return `[""]` so terminal scrollback doesn't duplicate chat history.
