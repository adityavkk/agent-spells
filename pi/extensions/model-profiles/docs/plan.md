# Model Profiles

## Summary

Pure Pi extension. No fork. Add profile+role based model selection under `pi/extensions/model-profiles/`. Source of truth: `model-profiles.json` files, not Pi core settings schema. Other code asks for a role like `fast`; resolver maps that to provider/model/thinking using current active profile, env/flag overrides, session state, and auth-aware fallback.

This document is implementation-ready and should be readable without the surrounding chat thread. It includes the intended UX, domain model, slice plan, constraints, and source references.

## References

### This repo

- Research artifact:
  - `pi/extensions/model-profiles/docs/research.md`
- Existing extension patterns:
  - `pi/extensions/answer/index.ts`
  - `pi/extensions/render/integration.test.ts`

### External inspiration

- oh-my-pi repository:
  - https://github.com/can1357/oh-my-pi
- oh-my-pi README model roles section:
  - https://github.com/can1357/oh-my-pi#-model-roles
- oh-my-pi model docs:
  - https://github.com/can1357/oh-my-pi/blob/main/docs/models.md

### Pi source material for implementation

Public docs/examples:

- Pi extensions docs:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Pi SDK docs:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Pi TUI docs:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
- Example extension: preset
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/preset.ts`
- Example extension: model status
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/model-status.ts`

Relevant exported Pi APIs verified during research:

- package exports:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts`
- extension API types:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
- extension runner command behavior:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/runner.js`
- settings manager surface:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/settings-manager.d.ts`
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/settings-manager.js`
- built-in `/model` interception:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- public model selector component:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/model-selector.d.ts`
- public thinking selector component:
  - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/thinking-selector.d.ts`

### Key findings from references

- extension can register commands, flags, shortcuts, status widgets, and custom TUI overlays
- extension can resolve and switch models with public Pi APIs
- built-in `/model` is hardcoded in interactive mode and cannot be replaced by extension commands
- duplicate extension command names are auto-renamed by Pi runtime rather than overriding built-ins
- `SettingsManager` does not expose typed first-class `modelProfiles` / `modelRoles` keys in current Pi
- current Pi settings loader preserves unknown JSON keys, but extension-managed raw `settings.json` edits are still higher risk than a dedicated config file

## Constraints and decisions

Hard constraints:

- no Pi fork for v1
- pure extension only
- built-in `/model` remains untouched
- no pretending extension owns Pi core startup model resolution globally

Design decisions:

- extension name: `model-profiles`
- source of truth: dedicated config files
  - `~/.pi/agent/model-profiles.json`
  - `<cwd>/.pi/model-profiles.json`
- profile = environment/policy bucket
- role = intent/latency-cost-quality bucket
- v1 controls only model + thinking selection
- v1 does not include tools/system prompt/preset behavior
- v1 consumers ask for roles like `fast`, not raw provider/model ids

## User Experience

### Mental model

- user thinks in two layers:
  - profile = environment/policy set
    - `work`, `personal`, `openai`, `local`
  - role = intent bucket inside that profile
    - `default`, `fast`, `workhorse`, `smart`
- user should rarely need to remember concrete model ids
- extensions/tests ask for role names like `fast`
- profile decides what `fast` means right now

### Config UX

Config file locations:

- global: `~/.pi/agent/model-profiles.json`
- project: `<cwd>/.pi/model-profiles.json`

Project file overrides global by profile/role key.

Example:

```json
{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "defaultRole": "workhorse",
      "roles": {
        "fast": {
          "provider": "openai-codex",
          "model": "gpt-5.4-mini",
          "thinkingLevel": "minimal"
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

### Interactive UX

#### Commands

Exact commands:

- `/profile`
  - no args: open profile selector
  - with arg: `/profile work`
- `/role`
  - no args: open role selector for active profile
  - with arg: `/role fast`
- `/model-profiles`
  - open combined selector / inspector
- `/model-profiles status`
  - print current active profile, role, resolved model, source, fallback trace
- `/model-profiles reload`
  - reload config files from disk

Command behavior:

- `/profile work`
  - sets active profile for current session
  - if profile has `defaultRole`, immediately resolves + applies it
  - if no `defaultRole`, keep current role if valid under new profile, else keep current model and warn
- `/role fast`
  - resolves role inside active profile
  - applies model + thinking immediately
- `/model-profiles`
  - opens one overlay, no hidden side effects until user confirms selection

Suggested command aliases in help text only, not extra registrations unless trivial:

- `profile:<name>` examples in docs
- `role:<name>` examples in docs

#### CLI / automation UX

Exact flags:

- `pi --profile work`
- `pi --role fast`
- `pi --profile work --role smart`

Exact env:

- `PI_MODEL_PROFILE=work`
- `PI_MODEL_ROLE=fast`

Precedence:

1. explicit flag
2. env
3. session active state
4. config `activeProfile`
5. current session model
6. first available model

Behavior notes:

- flags/env affect startup resolution for that run
- session state still persists after interactive changes unless explicitly cleared
- flags beat saved session state for the current run only

#### TUI modifications

Inspired by oh-my-pi, but implemented as extension-owned surfaces.

Footer/status:

- always show concise active state when extension loaded
- base format:
  - `profile:work role:fast`
- degraded format when raw model no longer matches active role mapping:
  - `profile:work role:fast raw-override`
- warning format when active role cannot currently resolve:
  - `profile:work role:fast unresolved`

Combined selector layout for `/model-profiles`:

- left pane: profiles
  - shows all profile names
  - badge for active profile
- middle pane: roles in selected profile
  - shows role name
  - shows compact target summary like `gpt-5.4-mini · minimal`
  - badge for profile default role
  - badge if currently active role
- right pane: details
  - resolved provider/model
  - thinking level
  - auth availability
  - fallback chain / trace
  - source of current selection: `flag|env|session|config|current-model|first-available`
- footer hints:
  - `↑↓ navigate • tab switch pane • enter apply • r reload • esc cancel`

Dedicated selectors:

- `/profile`
  - simple select list of profiles
  - preview line shows profile default role and resolved target
- `/role`
  - simple select list of roles for active profile
  - preview line shows full provider/model/thinking

Optional shortcut:

- one extension-owned shortcut opens combined selector
- do not steal built-in `/model` or built-in model keys

#### Notifications

Success copy:

- `Profile "work" activated`
- `Role "fast" -> openai-codex/gpt-5.4-mini`
- `Role "smart" -> anthropic/claude-opus-4-1 (thinking: high)`

Fallback copy:

- `Role "fast" target unavailable; using current model openai-codex/gpt-5.4`
- `Role "fast" target unavailable; using first available model anthropic/claude-sonnet-4-5`

Config copy:

- missing config:
  - `No model profiles configured. Create ~/.pi/agent/model-profiles.json or .pi/model-profiles.json`
- unknown profile:
  - `Unknown profile "work2". Available: work, personal, local`
- unknown role:
  - `Unknown role "ultra" in profile "work". Available: default, fast, workhorse, smart`

#### Failure scenarios

- config file missing
  - command still works enough to explain where config belongs
  - no crash
- config file invalid JSON
  - show exact file path + parse error
  - continue using session/current model unchanged
- profile exists but has no roles
  - activate profile only
  - notify that no roles are configured
- role maps to model not found in registry
  - skip candidate
  - continue fallback chain
- role maps to model without auth
  - skip candidate
  - continue fallback chain
- role maps to model that cannot support requested thinking level
  - apply model, clamp thinking through Pi behavior, notify if clamped
- user manually uses built-in `/model`
  - do not overwrite their choice immediately
  - footer shows `raw-override`
  - `/role fast` reasserts managed selection
- project config overrides global profile partially
  - merged result visible in inspector
  - no surprise hidden replacement of unrelated profiles

### Session UX

- active profile/role persist in session via custom entries
- reopening same session restores active profile/role indicator
- if restored selection resolves, apply it on session start
- if restored selection no longer resolves, keep session model and show warning
- role changes are normal session model changes in v1
  - visible in session history
  - not pretending to be temporary
- explicit user journey for restore:
  - open old session -> extension restores `profile:work role:fast` -> if valid, role mapping reapplied -> footer updates

### Consumer UX

For other extensions/tests:

- ask for a role, not a concrete model
- examples:
  - render extraction requests `fast`
  - future planner could request `smart`
- consumer gets `ResolvedRoleResult`
  - includes resolved model, thinking, source, trace
- if role resolution fails cleanly, consumer still gets deterministic fallback
  - current model, then first available
- consumer should be able to log trace for debugging without reimplementing selection logic

### User journeys

#### Journey 1 - first-time setup

1. user installs extension
2. runs `/model-profiles`
3. sees empty-state message pointing to config path
4. creates `~/.pi/agent/model-profiles.json`
5. reruns `/model-profiles`
6. selects `work`
7. extension applies `work.defaultRole`
8. footer shows `profile:work role:workhorse`

#### Journey 2 - quick interactive switch

1. user is in a work session
2. runs `/role fast`
3. extension resolves `work.fast`
4. model switches immediately
5. footer shows `profile:work role:fast`
6. render extension later asks for `fast` and gets same mapped model family

#### Journey 3 - project override

1. global config defines `work.fast -> gpt-5.4-mini`
2. project `.pi/model-profiles.json` overrides `work.fast -> local qwen`
3. user enters project session
4. `/role fast` uses project-specific mapping
5. inspector shows merged source and resolved target

#### Journey 4 - fallback under failure

1. user runs `/role smart`
2. configured smart model lacks auth today
3. extension notifies fallback
4. resolver uses current model or first available
5. footer still shows active role, but inspector/notification makes fallback explicit

#### Journey 5 - manual raw override

1. user uses built-in `/model`
2. Pi switches to arbitrary concrete model
3. extension notices model changed via `model_select`
4. footer changes to `profile:work role:fast raw-override`
5. user can return to managed selection with `/role fast`

### Non-goals UX

- built-in `/model` remains unchanged
- this extension does not hide or replace raw model selection
- user can still use `/model` manually
- this extension does not promise role aliases like `pi/fast` across all Pi internals
- if user manually overrides with `/model`, extension should reflect drift, not lie about it

## Implementer checklist

Before coding, read these in order:

1. `pi/extensions/model-profiles/docs/research.md`
2. Pi extension docs:
   - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
3. Pi SDK docs:
   - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
4. Pi TUI docs:
   - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
5. Pi example extensions:
   - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/preset.ts`
   - `/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/model-status.ts`

Implementation rules:

- keep this as pure extension code in this repo
- do not patch Pi internals
- do not reimplement built-in `/model`
- keep resolver logic UI-free and importable from tests/other extensions
- keep config merge + resolution deterministic and well tested
- document manual interactive verification steps in README

## Domain Model

### Nouns (Types)

- `ModelRoleName = string`
- `ModelProfileName = string`
- `ResolvedModelRef = { provider: string; model: string; thinkingLevel?: ThinkingLevel }`
- `ModelRoleConfig = { provider?: string; model?: string; thinkingLevel?: ThinkingLevel; fallback?: string[] }`
- `ModelProfileConfig = { defaultRole?: string; roles: Record<ModelRoleName, ModelRoleConfig> }`
- `ModelProfilesConfig = { activeProfile?: ModelProfileName; profiles: Record<ModelProfileName, ModelProfileConfig> }`
- `ModelProfilesState = { activeProfile?: ModelProfileName; activeRole?: ModelRoleName }`
- `ResolvedRoleResult = { model: Model<any>; thinkingLevel?: ThinkingLevel; profile?: string; role?: string; source: "flag" | "env" | "session" | "config" | "current-model" | "first-available"; trace: string[] }`

### Verbs (Operations)

- `loadModelProfilesConfig(cwd) -> { globalConfig, projectConfig, mergedConfig }`
- `readModelProfilesState(sessionManager) -> ModelProfilesState`
- `resolveModelRole(input) -> Promise<ResolvedRoleResult>`
- `applyResolvedModelRole(pi, resolved) -> Promise<boolean>`
- `setActiveProfile(pi, profile)`
- `setActiveRole(pi, role)`
- `renderProfileSelector(...)`
- `renderRoleSelector(...)`

### Boundaries

- Pi public extension/runtime boundary
  - `ExtensionAPI`
  - `ExtensionContext`
  - `ModelRegistry`
  - `ModelSelectorComponent`
  - `ThinkingSelectorComponent`
- File config boundary
  - `~/.pi/agent/model-profiles.json`
  - `<cwd>/.pi/model-profiles.json`
- Session persistence boundary
  - custom session entries only
- Consumer boundary
  - `render` tests/helpers call resolver, not raw provider/model ids

## Acceptance criteria

Implementation is complete when all of these are true:

- user can define profiles and roles in `model-profiles.json`
- user can switch profile with `/profile` and role with `/role`
- switching applies resolved model and thinking immediately
- footer/status shows active profile/role and drift state (`raw-override` / `unresolved`)
- session restore rehydrates active profile/role when possible
- resolver exposes enough metadata for consumers/tests (`source`, `trace`)
- render integration can request role `fast` without hardcoding a concrete provider/model
- invalid config and missing auth degrade gracefully with explicit user-visible errors/warnings
- unit tests cover config merge and resolution fallbacks
- README explains config, commands, precedence, failure cases, and manual verification

## Slices

### Slice 1: Resolver tracer bullet

End-to-end: config -> merged config -> auth-aware model resolution -> tests.

Files
- `pi/extensions/model-profiles/types.ts`
- `pi/extensions/model-profiles/config.ts`
- `pi/extensions/model-profiles/resolve.ts`
- `pi/extensions/model-profiles/config.test.ts`
- `pi/extensions/model-profiles/resolve.test.ts`

Changes
- define config/state/result types
- load global+project config files
- merge profiles shallow-by-profile, roles shallow-by-role
- resolve role with fallback chain:
  - explicit env/args inputs to resolver
  - active session profile/role
  - config active profile + requested role
  - profile default role
  - current model
  - first available model
- check auth with `modelRegistry.getApiKeyAndHeaders()` before accepting candidate

Verify
- unit tests only
- no extension UI yet

### Slice 2: Extension shell + session state

End-to-end: load extension, activate profile/role via commands, switch model/thinking, persist active selection in session.

Files
- `pi/extensions/model-profiles/index.ts`
- `pi/extensions/model-profiles/state.ts`
- `pi/extensions/model-profiles/index.test.ts`
- `pi/extensions/model-profiles/README.md`

Changes
- register flags:
  - `profile`
  - `role`
- register commands:
  - `/profile`
  - `/role`
  - `/model-profiles`
- session start:
  - load config
  - read session custom entries
  - apply `--profile` / `--role` if present
- persist state with `pi.appendEntry("model-profiles-state", ...)`
- show footer status like `profile:work role:fast`

Verify
- command-level tests where possible
- session-state round-trip tests

### Slice 3: Interactive selectors

End-to-end: interactive selection UI for profiles and roles using public Pi/TUI components.

Files
- `pi/extensions/model-profiles/ui.ts`
- `pi/extensions/model-profiles/index.ts`

Changes
- custom selector for profiles
- custom selector for roles in active profile
- optional detail pane shows target provider/model/thinking/fallback
- optional shortcut opens combined selector
- `/model-profiles` opens combined UI

Verify
- light behavioral tests for pure helpers
- manual interactive smoke test documented in README

### Slice 4: Render consumer integration

End-to-end: render integration harness asks for `fast` instead of hardcoded provider/model.

Files
- `pi/extensions/render/integration.test.ts`
- maybe `pi/extensions/render/test-model.ts` if helper needed

Changes
- import resolver from `model-profiles`
- default test role = `fast`
- allow env override for explicit provider/model to preserve escape hatch
- keep existing Pi registry auth path

Verify
- `bun test pi/extensions/render/integration.test.ts`
- smoke with profile mapping to `openai-codex/gpt-5.4-mini`

### Slice 5: Optional answer migration

End-to-end: answer extraction model selection uses role resolver instead of hardcoded Ollama preference.

Files
- `pi/extensions/answer/index.ts`
- tests if practical

Changes
- replace `selectExtractionModel()` hardcode with role-aware resolution
- likely role name `fast` or `extract`

Verify
- answer integration tests if available

## Risks & Mitigations

- Risk: config schema balloons | Mitigation: v1 supports only provider/model/thinking/fallback
- Risk: confusion with presets | Mitigation: README says model-profiles only controls model/thinking
- Risk: no built-in `/model` integration | Mitigation: explicit `/profile`, `/role`, `/model-profiles`
- Risk: role switch pollutes session model history | Mitigation: accept in v1; document; avoid pretending temporary switch exists
- Risk: consumer imports from extension path awkwardly | Mitigation: keep resolver files pure TS, no UI deps
- Risk: missing auth for mapped model | Mitigation: resolver skips unauthenticated candidates, records trace

## Open Questions

- [ ] default role set: `default|fast|workhorse|smart` only?
- [ ] support alias roles like `smol|slow|plan|commit` in v1, or later?
- [ ] should fallback be `string[]` role refs only, or allow explicit `provider/model` refs too?
- [ ] make Slice 5 in scope now, or after render proves design?

## Out of Scope

- overriding built-in `/model`
- patching Pi core startup model resolution
- adding first-class `modelProfiles` keys to Pi `SettingsManager`
- canonical model/provider coalescing like oh-my-pi core
- tool/prompt/system-prompt presets