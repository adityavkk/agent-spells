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

Press `Ctrl+X` or run `/lk` to open the leader-key palette.
