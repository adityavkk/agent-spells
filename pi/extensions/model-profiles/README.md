# model-profiles

Pure Pi extension for profile + role based model selection.

Role names are user-defined.

Examples:

- `small`
- `smol`
- `workhorse`
- `smart`
- `writer`

## What it does

- loads model profile config from:
  - `~/.pi/agent/model-profiles.json`
  - `<cwd>/.pi/model-profiles.json`
- resolves model selection from:
  - profile
  - role
  - Pi model registry auth availability
  - ordered fallback targets per role
  - fallback to current model / first available model when nothing resolves
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
  "activeProfile": "work",
  "profiles": {
    "work": {
      "defaultRole": "workhorse",
      "roles": {
        "smol": {
          "targets": [
            {
              "provider": "code-puppy",
              "model": "claude-haiku-4-5-20251001"
            },
            {
              "provider": "wibey-anthropic",
              "model": "claude-haiku-4-5-20251001"
            }
          ]
        },
        "workhorse": {
          "targets": [
            {
              "provider": "code-puppy",
              "model": "gpt-5.4",
              "thinkingLevel": "high"
            }
          ]
        },
        "smart": {
          "targets": [
            {
              "provider": "code-puppy",
              "model": "gpt-5.4",
              "thinkingLevel": "high"
            },
            {
              "provider": "wibey-anthropic",
              "model": "claude-opus-4-6"
            },
            {
              "provider": "code-puppy",
              "model": "claude-opus-4-6"
            }
          ]
        }
      }
    }
  }
}
```

Legacy single-target role config still works:

```json
{
  "small": {
    "provider": "openai-codex",
    "model": "gpt-5.4-mini",
    "thinkingLevel": "minimal"
  }
}
```

## Notes

- built-in `/model` stays unchanged
- manual `/model` changes show as `raw-override`
- role resolution is auth-aware
- ordered target lists are tried in order during preflight resolution
- runtime fallback retries the next configured target on retryable failures such as:
  - 429 / rate limit
  - 5xx / overloaded / timeout style errors
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
