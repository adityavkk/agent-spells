# model-profiles

Pure Pi extension for profile + role based model selection.

Canonical small-model role name:

- `small`
- inspired by oh-my-pi `smol`

## What it does

- loads model profile config from:
  - `~/.pi/agent/model-profiles.json`
  - `<cwd>/.pi/model-profiles.json`
- lets users activate:
  - profiles via `/profile`
  - roles via `/role`
- persists active selection in session custom entries
- shows footer status like:
  - `profile:work role:small`
  - `profile:work role:small raw-override`
  - `profile:work role:small unresolved`

## Commands

- `/profile`
- `/profile <name>`
- `/role`
- `/role <name>`
- `/model-profiles`
- `/model-profiles status`
- `/model-profiles reload`

## Flags

- `--profile <name>`
- `--role <name>`

## Config

Example:

```json
{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "defaultRole": "workhorse",
      "roles": {
        "small": {
          "provider": "openai-codex",
          "model": "gpt-5.4-mini",
          "thinkingLevel": "minimal",
          "fallback": ["workhorse", "smart"]
        },
        "workhorse": {
          "provider": "openai-codex",
          "model": "gpt-5.4",
          "thinkingLevel": "medium"
        },
        "smart": {
          "provider": "anthropic",
          "model": "claude-opus-4-1",
          "thinkingLevel": "high"
        }
      }
    }
  }
}
```

## Notes

- built-in `/model` stays unchanged
- manual `/model` changes show as `raw-override`
- role resolution is auth-aware
- unresolved role mappings fall back to current model, then first available model

## Docs

- plan: `./docs/plan.md`
- research: `./docs/research.md`
