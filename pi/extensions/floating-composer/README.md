# floating-composer

Opencode-inspired composer surface for pi. Replaces the default editor + footer
with a single dark panel:

- single left accent bar (`┃`) instead of a full rounded box
- theme-variable-driven panel fill spanning the entire terminal width
- provider/model + context percentage rendered inline inside the panel
- pwd · branch  |  provider usage printed on a plain row below the panel

Sketch at width 100:

```
┃
┃  the quick brown fox jumps over the lazy dog 123
┃
┃  profiles/build:coder · anthropic/claude-sonnet-4-5-20250929            45% (90k/200k)
 ~/dev/agent-spells · main                              Claude · 5h ━━━━────── 38% 3h
```

## Context display

- just `<pct>%` at narrow widths
- `<pct>% (<used>/<total>)` at wider widths
- percentage is color-coded (success → accent → warning → error) as the
  context fills up
- no "ctx" prefix, no bar

## Responsive behavior

Panel fills the terminal width with a 0-column outer margin (1 column at
terminal widths >= 160).

Outside row:

| width   | left            | right                                |
|---------|-----------------|--------------------------------------|
| >= 60   | pwd · branch    | provider usage (windows with bars)   |
| < 60    | pwd · branch    | hidden                               |

Usage data is provider-specific (Claude, Codex, Copilot, Gemini, MiniMax) and
refreshes every 5 minutes while the session is live.

## Theme vars

`floating-composer` reads optional custom vars from the active theme JSON's
`vars` object:

- `floatingComposerBg` — composer panel background

Fallback aliases also supported for reuse across themes:

- `composerPanelBg`
- `panelBg`

Example:

```json
{
  "vars": {
    "floatingComposerBg": "#11111b"
  }
}
```

Dark and light themes can set different values. No pi core theme tokens are
required.

## Usage

- enable `floating-composer`
- disable `minimal-footer` and `floating-footer`

Path: `~/dev/agent-spells/pi/extensions/floating-composer/`

## References

- opencode composer source:
  `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` (anomalyco/opencode)
- uses `ExtensionAPI.ui.setEditorComponent` + `setFooter` from pi-coding-agent
