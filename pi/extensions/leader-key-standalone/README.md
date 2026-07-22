# Leader Key Standalone

Agent-spells owned fork of the `leader-key` Pi extension from `tomsej/pi-ext`.

Origin:
- `https://github.com/tomsej/pi-ext`
- upstream path: `extensions/leader-key`
- this folder was imported from the active local copy at `~/.pi/agent/extensions/leader-key-standalone`
- upstream license retained in `LICENSE.tomsej-pi-ext`

Local ownership notes:
- shared overlay and clipboard helpers are vendored into this folder so it is standalone
- thinking picker reads/writes effective profile thinking via the optional `model-profiles:*` event bridge

Press `Ctrl+,` or run `/lk` to open the leader-key palette.

Shortcut policy:
- Keep Pi native shortcuts intact.
- Use `Ctrl+,` for this extension's leader key to avoid collisions with native `Ctrl+X` copy behavior.
