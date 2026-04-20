# floating-composer

Opencode-inspired composer surface for pi. Replaces the default editor + footer
with a single dark panel:

- single left accent bar (`│`) instead of a full rounded box
- dark-grey (`selectedBg`) fill spanning the entire terminal width
- provider/model + context gauge rendered inline inside the panel
- shadow-foot `╹▀▀▀…` under the panel (muted border color)
- pwd · branch  |  provider usage printed on a plain row below the panel

Sketch at width 100:

```
│
│  the quick brown fox jumps over the lazy dog 123
│
│  profiles/build:coder · anthropic/claude-sonnet-4-5-20250929   ctx ━━━━━━────── 45% 12k/200k
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 ~/dev/agent-spells · main                              Claude · 5h ━━━━────── 38% 3h
```

## Responsive behavior

Panel fills the terminal width with a 0-column outer margin (1 column at
terminal widths >= 160). Inside the panel:

| width   | status row                         | ctx gauge                    |
|---------|------------------------------------|------------------------------|
| >= 100  | profile + provider/model + think   | bar 10-12 + counts           |
| 70-99   | profile + provider/model + think   | bar 8-10, no counts          |
| 50-69   | model truncated with `…`           | bar 6-8, no counts           |
| < 50    | model may wrap/truncate            | bar 4-6, no counts           |

Outside row:

| width   | left            | right                                |
|---------|-----------------|--------------------------------------|
| >= 60   | pwd · branch    | provider usage (windows with bars)   |
| < 60    | pwd · branch    | hidden                               |

Usage data is provider-specific (Claude, Codex, Copilot, Gemini, MiniMax) and
refreshes every 5 minutes while the session is live.

## Usage

- enable `floating-composer`
- disable `minimal-footer` and `floating-footer`

Path: `~/dev/agent-spells/pi/extensions/floating-composer/`

## References

- opencode composer source:
  `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` (anomalyco/opencode)
- uses `ExtensionAPI.ui.setEditorComponent` + `setFooter` from pi-coding-agent
