# vim-modal-editor

Vim-style modal editing for Pi's prompt box.

Loads as a Pi editor wrapper:

- wraps any previously configured custom editor with `ctx.ui.getEditorComponent()`
- falls back to Pi's `CustomEditor`
- preserves Pi app shortcuts, autocomplete, focus, submit/change callbacks

## Keys

Insert mode:

- `Esc` -> normal mode

Normal mode:

- `h` `j` `k` `l` -> move
- `w` `b` -> word movement
- `0` `$` -> line start/end
- `i` `a` `I` `A` -> enter insert mode
- `x` `X` `D` `C` `s` `S` -> delete/change shorthands
- `d` / `c` operators with counts: `dw`, `d2w`, `2dw`, `dd`, `cc`
- numeric counts for motions: `2w`, `3h`, `10l`

