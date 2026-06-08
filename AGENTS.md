# AGENTS.md

Project-local notes for `agent-spells`.

## Letta provider-tool sync

`pi/extensions/provider-tool-profiles` tracks Letta Code tool schemas/descriptions without auto-activating upstream capabilities.

Use this drift check before/after Letta-related changes:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main
```

Then read:

- `.tmp/letta-drift/summary.md`
- `.tmp/letta-drift/recommended-actions.md`

Refresh vendored files only from the manifest:

```bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts --ref <sha>
```

Important boundaries:

- Vendored upstream schema does not mean implemented locally.
- Implemented local wrapper does not mean activated by default.
- Do not auto-activate new Letta tools or broaden Pi capabilities during sync.
- `exec_command` / `write_stdin` stay blocked until Pi has explicit session/stdin/polling semantics.

Primary doc: `pi/extensions/provider-tool-profiles/docs/letta-sync.md`.
