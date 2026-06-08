# answer

Interactive answer flow for agent-generated questions.

## Files

- `index.ts` - extension entrypoint
- `extraction.ts` - structured extraction bridge
- `core.ts` - normalized types and answer formatting
- `ui.ts` - interactive terminal UI
- `config.ts` - per-extension model selection config (`answer.json`)
- `baml_src/` - answer-specific BAML source types and prompts
- `baml_client/` - generated answer-specific TypeScript client
- `debug.ts` - gated debug logging
- `*.test.ts` - unit/integration coverage

## Model selection

Question extraction runs through `model-profiles`. By default the extension
walks the role candidates `["small", "smol"]` against your active profile
(session > config). It does NOT silently fall through to the profile's
`defaultRole` (e.g. a heavy `smart` model), which used to cause Claude Opus
to be picked for cheap extraction work.

### Where to configure

Per-extension config (optional):

- global: `~/.pi/agent/answer.json`
- project: `<cwd>/.pi/answer.json` (wins on conflict)

Both files share the same shape:

```json
{
  "modelSelection": {
    "profile": "work",
    "role": "smol",
    "rolesByProfile": { "work": "smol", "personal": "small" },
    "roleCandidates": ["small", "smol"],
    "useActiveProfile": true,
    "fallbackToActiveRole": false,
    "fallbackToDefaultRole": false,
    "provider": "openai-codex",
    "model": "gpt-5.4-mini",
    "thinkingLevel": "minimal",
    "targets": [
      { "provider": "openai-codex", "model": "gpt-5.4-mini", "thinkingLevel": "minimal" }
    ],
    "targetsByProfile": {
      "work": [{ "provider": "wibey-anthropic", "model": "claude-haiku-4-5-20251001" }]
    }
  }
}
```

All fields are optional. Resolution order:

1. `targetsByProfile[<active profile>]` if set.
2. `targets` if set.
3. `provider`+`model` if both set (legacy single-target).
4. Walk role candidates against the active profile:
   - `rolesByProfile[<active profile>]` (if set)
   - `role` (if set)
   - `roleCandidates` or built-in `["small", "smol"]`
   - active session role (unless `fallbackToActiveRole: false`)
   - profile `defaultRole` (unless `fallbackToDefaultRole: false`)
5. Final safety net: current session model, then first available.

Each role candidate is matched against the profile only - missing roles do
not bleed into the profile's `defaultRole`.

### Defaults if you do nothing

No config required. With your existing `~/.pi/agent/model-profiles.json`,
the extension will pick the first matching role from `["small", "smol"]` on
the currently active profile. Config target lists are honored, including
ordered fallback candidates passed to `completeWithModelRoleFallback`.

## Test coverage

- core normalization and transcript formatting
- extraction bridge request/parse behavior
- per-extension config normalization, merging, and load behavior
- live integration against local Ollama when available
