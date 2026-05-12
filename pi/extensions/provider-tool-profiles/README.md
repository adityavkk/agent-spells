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

## Letta snapshot

Schemas/descriptions are vendored from Letta Code for source-of-truth comparison and refreshability:

- `vendor/letta/SOURCE.md`
- `vendor/letta/schemas/*.json`
- `vendor/letta/descriptions/*.md`

Runtime implementation is local Pi wrapper code, not Letta runtime internals.

Refresh:

```bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts
```

## Known gaps

- Claude `Bash.run_in_background` returns an unsupported message in v1.
- Codex `apply_patch` supports add/update/delete with context hunks, not every exotic patch directive.
- `update_plan` stores plan state in-memory for the extension instance only.
- `read_many_files`, `glob`, and grep wrappers rely on `rg`.
- No Letta memory/task/skill/approval system included.

## Tests

```bash
bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts
```
