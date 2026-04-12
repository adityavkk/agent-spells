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
- exposes profile roles as synthetic native Pi models through provider:
  - `profiles`
  - example synthetic model id: `personal:smart`
- lets users activate profiles and roles through one command:
  - `/profile`
  - `/profile personal`
  - `/profile smart`
  - `/profile personal:smart`
  - `/profile status`
  - `/profile reload`
  - `/profile reset`
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
- `/profile reset`
  - reset sticky round-robin cursor for active profile role back to first configured target

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

## Native synthetic provider behavior

When a profile role is managed successfully, `/profile personal:smart` does not set the session to the raw concrete model.
It sets the session to a synthetic model under provider `profiles`:

- `profiles/personal:smart`

At request time that synthetic provider:

1. resolves the ordered concrete targets for `personal:smart`
2. applies target-specific auth and headers
3. applies target-specific thinking
4. streams with fallback across retryable failures

This makes profile roles feel like normal Pi model selections rather than answer/render-specific glue.

Sticky runtime policy:

- each profile role keeps a sticky round-robin cursor
- each new turn starts from the current cursor
- retries wrap around the remaining targets in round-robin order
- on success, cursor sticks to the winning concrete target
- `/profile reset` clears the sticky cursor so the next turn starts from the first configured target again
- footer model display shows the last concrete winner, while the logical status line still shows `profile:role`

## Runtime fallback behavior

Retryable failures:

- `429`
- `too many requests`
- `rate limit`
- `throttle` / `throttled`
- `500` / `502` / `503` / `504`
- `overloaded`
- `temporarily unavailable`
- `timeout` / `timed out`
- `connection reset` / `econnreset`
- `server error`

Non-retryable failures stop immediately.
Examples:

- unsupported parameters
- invalid model id
- malformed payload
- other provider errors not classified as transient

Important streaming caveat:

- fallback only happens before visible output is committed
- if a provider already emitted visible text/thinking/tool-call deltas and then fails, the extension does not jump to another model mid-stream
- reason: cannot safely replay/erase already-shown output without corrupting turn semantics

So universal fallback is strongest for:

- pre-output provider failures
- request setup failures
- early transport failures
- early retryable provider errors

## Current diagnostics state

`/profile status` now shows:

- logical selection
- synthetic active session model
- sticky cursor position
- last winning concrete target
- attempt trace for the latest profile-backed turn

See `./docs/runtime-diagnostics.md`.

## Notes

- built-in `/model` stays unchanged
- manual `/model` changes show as `raw-override`
- role resolution is auth-aware
- ordered target lists are tried in order during preflight resolution
- synthetic provider runtime fallback retries the next configured target on retryable failures
- unresolved role mappings fall back to current model, then first available model
- roles without `thinkingLevel` explicitly reset thinking to `off`
- this is a proper Pi extension:
  - registers flags and `/profile`
  - listens to `session_start` and `model_select`
  - registers synthetic provider/models via `pi.registerProvider(...)`
  - applies model switches via `pi.setModel(...)`
  - applies thinking via `pi.setThinkingLevel(...)`
  - persists session state via `pi.appendEntry(...)`

## Docs

- plan: `./docs/plan.md`
- research: `./docs/research.md`
- universal fallback plan: `./docs/universal-fallback-plan.md`
- runtime diagnostics: `./docs/runtime-diagnostics.md`
