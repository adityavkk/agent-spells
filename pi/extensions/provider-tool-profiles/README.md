# provider-tool-profiles

Pi extension that swaps Pi's core tool surface to provider-native tool profiles:

- Claude/Anthropic: `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`
- OpenAI/Codex/GPT: `shell_command`, `apply_patch`, `update_plan`, `view_image`
- Gemini/Google: `run_shell_command`, `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `search_file_content`, `replace`, `write_file`

Intent: no new broad capabilities. Same local file/shell operations, model-native schema names.

## How it works

On `session_start` and `model_select`:

1. Detect model family from provider/id/api.
2. Register all managed tools once.
3. Activate only matching profile tools.
4. Preserve unrelated extension tools already active.
5. Restore prior Pi core tools when no profile applies.

A concise profile note is appended in `before_agent_start`.

## Config

Global: `~/.pi/agent/provider-tool-profiles.json`
Project: `.pi/provider-tool-profiles.json`

Project config overrides global config.

```json
{
  "enabled": true,
  "preserveExtensionTools": true,
  "fallbackTools": ["read", "bash", "edit", "write"],
  "profiles": {
    "claude": true,
    "codex": true,
    "gemini": true
  },
  "matchers": {
    "claude": {
      "providerIncludes": ["anthropic"],
      "idIncludes": ["claude"],
      "apiIncludes": ["anthropic"]
    },
    "codex": {
      "providerIncludes": ["openai-codex"],
      "idIncludes": ["codex"],
      "apiIncludes": ["openai"]
    },
    "gemini": {
      "providerIncludes": ["google", "gemini"],
      "idIncludes": ["gemini"],
      "apiIncludes": ["google", "gemini"]
    }
  }
}
```

Env overrides:

```bash
PI_PROVIDER_TOOL_PROFILES=0       # disable
PI_PROVIDER_TOOL_PROFILE=claude   # force claude|codex|gemini|off
```

Default decision: GPT `gpt-*` models from OpenAI get the Codex profile. Reason: issue goal explicitly says OpenAI / Codex / GPT.

## model-profiles integration

This extension understands the sibling `model-profiles` extension's synthetic provider:

- `profiles/<profile>:<role>` is resolved through `model-profiles.json` before family detection.
- Sticky runtime winners from `model-profiles-runtime-state` win when present.
- Otherwise the current sticky cursor/first resolved target decides the tool profile.

Caveat: if one profile role mixes model families and runtime fallback jumps from one family to another inside the same request, Pi has already built the provider payload with the initially selected tool schema. Prefer same-family targets within one role for strongest native-tool matching.

## Letta snapshot

Schemas/descriptions are vendored from Letta Code for source-of-truth comparison and refreshability:

- `vendor/letta/SOURCE.md`
- `vendor/letta/schemas/*.json`
- `vendor/letta/descriptions/*.md`

Runtime implementation is local Pi wrapper code, not Letta runtime internals.

The vendored Codex snapshot includes both the currently active compatibility surface
(`shell_command`, `apply_patch`, `update_plan`, `view_image`) and newer upstream
Codex schemas (`exec_command`, `write_stdin`, `shell`, `read_file`, `list_dir`).
Those newer schemas are not activated by default until Pi has an explicit design for
long-running exec sessions and stdin/polling behavior.

Refresh:

```bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts
```

Sync strategy and future automation plan: `docs/letta-sync.md`.

## Known gaps

- Claude `Bash.run_in_background` returns an unsupported message in v1.
- Latest upstream Codex defaults use `exec_command` and `write_stdin`; this extension still activates `shell_command` until session semantics are designed.
- Codex `apply_patch` supports add/update/delete with context hunks, not every exotic patch directive.
- `update_plan` stores plan state in-memory for the extension instance only.
- `read_many_files`, `glob`, and grep wrappers rely on `rg`.
- No Letta memory/task/skill/approval system included.

## Smoke prompts

See `docs/smoke-prompts.md` for manual A/B prompts across Claude, Codex/GPT, and Gemini.

## Tests

```bash
bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts
```
