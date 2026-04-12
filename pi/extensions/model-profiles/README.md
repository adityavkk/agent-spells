# model-profiles

Pure Pi extension for profile + role based model selection.

Canonical small-model role name:

- `small`
- inspired by oh-my-pi `smol`

## What it does

- loads model profile config from:
  - `~/.pi/agent/model-profiles.json`
  - `<cwd>/.pi/model-profiles.json`
- lets users activate profiles and roles through one command:
  - `/profile`
  - `/profile personal`
  - `/profile smart`
  - `/profile personal:smart`
- persists active selection in session custom entries
- shows footer status like:
  - `personal:small`
  - `personal:small raw-override`
  - `personal:small unresolved`

## Commands

- `/profile`
  - interactive profile + role picker
- `/profile <profile>`
  - activate profile default role
- `/profile <role>`
  - switch role inside active profile
- `/profile <profile>:<role>`
  - activate explicit profile + role
- `/profile status`
- `/profile reload`

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
