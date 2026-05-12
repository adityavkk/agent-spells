# Provider Tool Profiles

Pi extension that swaps Pi's model-agnostic core tools for provider-native core tool schemas:

- Claude-style: `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`
- Codex-style: `shell_command`, `apply_patch`, `update_plan`, `view_image`
- Gemini-style: `run_shell_command`, `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `search_file_content`, `replace`, `write_file`

The extension registers all managed tools up front, then activates the matching profile on `session_start` and `model_select`. Non-managed extension tools stay active. When no profile matches, the previous/default Pi core tools are restored.

## Config

Optional config lives at `~/.pi/agent/provider-tool-profiles.json` or `<project>/.pi/provider-tool-profiles.json`:

```json
{
  "enabled": true,
  "profiles": {
    "claude": true,
    "codex": true,
    "gemini": true
  },
  "fallbackTools": ["read", "bash", "edit", "write"],
  "modelMatchers": {
    "claude": ["anthropic", "claude"],
    "codex": ["openai-codex", "codex", "gpt-"],
    "gemini": ["google", "gemini"]
  }
}
```

Environment overrides:

- `PI_PROVIDER_TOOL_PROFILES=0` disables the extension.
- `PI_PROVIDER_TOOL_PROFILE=claude|codex|gemini|off` forces a profile.

## Notes

This is a Pi adapter, not a reimplementation of Claude Code, Codex CLI, Gemini CLI, or Letta Code. Shell execution goes through `pi.exec`; file operations resolve relative paths against `ctx.cwd`; Codex `apply_patch` supports add, delete, update, and move operations for the standard `*** Begin Patch` format.

Reference schemas and descriptions are vendored from Letta Code at `vendor/letta/` with Apache-2.0 attribution. Refresh them with:

```bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts
```

