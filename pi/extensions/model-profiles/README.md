# model-profiles

Pure Pi extension for profile + role based model selection.

Canonical small-model role name:

- `small`
- inspired by oh-my-pi `smol`

## What it does

- loads model profile config from:
  - `~/.pi/agent/model-profiles.json`
  - `<cwd>/.pi/model-profiles.json`
- resolves model selection from:
  - profile
  - role
  - Pi model registry auth availability
  - fallback chain
- lets users activate profiles and roles through one command:
  - `/profile`
  - `/profile personal`
  - `/profile smart`
  - `/profile personal:smart`
  - `/profile status`
  - `/profile reload`
- persists active selection in session custom entries
- shows footer status like:
  - `personal:small`
  - `personal:small raw-override`
  - `personal:small unresolved`
- keeps current scope narrow:
  - model + thinking only
  - command UX intentionally generic enough to extend later

## Commands

- `/profile`
  - interactive profile + role picker
- `/profile <profile>`
  - activate profile default role, or current role if compatible
- `/profile <role>`
  - switch role inside active profile
- `/profile <profile>:<role>`
  - activate explicit profile + role
- `/profile status`
  - show active profile, role, resolved model, source, and summary
- `/profile reload`
  - reload config from disk

## Flags

- `--profile <name>`
- `--role <name>`

Precedence:

1. CLI flags
2. env (`PI_MODEL_PROFILE`, `PI_MODEL_ROLE`)
3. session-persisted active state
4. config `activeProfile`
5. current session model
6. first available model

## Config

Example:

```json
{
  "activeProfile": "personal",
  "profiles": {
    "personal": {
      "defaultRole": "small",
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
          "fallback": ["smart"]
        },
        "smart": {
          "provider": "openai-codex",
          "model": "gpt-5.4",
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
- roles without `thinkingLevel` explicitly reset thinking to `off`
- this is a proper Pi extension:
  - registers flags and `/profile`
  - listens to `session_start` and `model_select`
  - applies model switches via `pi.setModel(...)`
  - applies thinking via `pi.setThinkingLevel(...)`
  - persists session state via `pi.appendEntry(...)`

## Docs

- plan: `./docs/plan.md`
- research: `./docs/research.md`
