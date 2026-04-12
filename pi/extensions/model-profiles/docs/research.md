# Model Profiles - Research

## Context

- target repo: `~/dev/agent-spells`
- existing extension patterns:
  - `pi/extensions/answer/index.ts`
  - `pi/extensions/render/integration.test.ts`
- current model selection in repo still ad hoc:
  - `answer/index.ts` has hardcoded extraction preference `ollama/gemma4:e4b`, else current session model
  - `render/integration.test.ts` now resolves concrete models from Pi `AuthStorage` + `ModelRegistry`, but still by explicit provider/model ids
- current package surface in repo:
  - `package.json` depends on `@mariozechner/pi-ai`, not local `@mariozechner/pi-coding-agent`
  - extension code already imports Pi extension types from global install pattern

## Pi runtime / extension facts

- useful extension APIs already exist:
  - `ctx.model`, `ctx.modelRegistry`
  - `pi.setModel(model)`
  - `pi.setThinkingLevel(level)`
  - `pi.registerCommand(...)`
  - `pi.registerFlag(...)`
  - `pi.registerShortcut(...)`
  - `pi.appendEntry(...)`
  - `pi.on("model_select", ...)`
- extension modules can also import public Pi exports directly from `@mariozechner/pi-coding-agent`
  - confirmed exported:
    - `SettingsManager`
    - `ModelRegistry`
    - `SessionManager`
    - `ModelSelectorComponent`
    - `ThinkingSelectorComponent`
    - `DefaultResourceLoader`
- existing reference pattern: `examples/extensions/preset.ts`
  - loads config from `~/.pi/agent/presets.json` and `<cwd>/.pi/presets.json`
  - applies model/thinking/tools via extension APIs
  - persists active preset in session via `pi.appendEntry("preset-state", ...)`

## Pure-extension feasibility

This can go pretty far as a pure extension. More than first pass suggested.

What a pure extension can do today:

- ship as normal Pi extension package under:
  - `~/.pi/agent/extensions/model-profiles/`
  - or project `.pi/extensions/model-profiles/`
- load its own config files
- register commands, flags, shortcuts, status widgets
- create custom TUI selectors with public Pi components
  - `ModelSelectorComponent`
  - `ThinkingSelectorComponent`
- resolve models via public `ModelRegistry`
- switch current session model via `pi.setModel(...)`
- switch current session thinking via `pi.setThinkingLevel(...)`
- persist extension state in session via `pi.appendEntry(...)`

What it still cannot do cleanly as pure extension:

- replace built-in `/model`
- patch built-in model selector behavior in place
- hook core startup model resolution so all of Pi understands roles natively
- add first-class typed keys to Pi `SettingsManager` schema without upstream changes

## Current Pi settings/model surface

- installed Pi today supports:
  - `defaultProvider`
  - `defaultModel`
  - `defaultThinkingLevel`
  - `enabledModels`
- installed Pi today does **not** expose first-class `modelRoles` / `modelProfiles`
  - confirmed in `docs/settings.md`, `docs/models.md`, `dist/core/settings-manager.d.ts`
- but current settings implementation is more permissive than schema suggests:
  - `SettingsManager.loadFromStorage()` parses raw JSON and keeps unknown keys in memory
  - `persistScopedSettings()` merges modified known fields into current file JSON, preserving unknown keys already present in the file
- implication:
  - extension could store custom `modelProfiles` / `activeModelProfile` keys inside Pi `settings.json` by manually editing JSON files
  - Pi core would ignore those keys, but also likely not delete them during ordinary settings writes
  - caveat: no public file-lock helper is exported, so concurrent write safety would be on the extension
- extension-local config file is still cleaner for v1
  - `model-profiles.json` avoids settings write races and schema confusion

## Built-in command / selector constraints

- built-in `/model` is hardcoded in interactive mode
  - interactive mode intercepts `/model` before extension command execution
- extension command names do not override built-ins
- duplicate extension command names are auto-renamed by Pi runtime
  - example behavior: `foo`, `foo:2`, `foo:3`
- implication:
  - pure extension should provide separate commands such as `/profile`, `/role`, `/model-profiles`
  - or a shortcut-driven selector
  - trying to shadow `/model` is dead end

## External inspiration: oh-my-pi

Used `search` CLI:

- `search fetch https://github.com/can1357/oh-my-pi --json`
- `search web "can1357 oh-my-pi model roles" --json`

Relevant README/docs excerpts from local fetched repo:

- `README.md`
  - "Role-based routing: `default`, `smol`, `slow`, `plan`, and `commit` roles"
  - "Role-based selection: Task tool agents can use `model: pi/smol` for cost-effective exploration"
  - "CLI args (`--smol`, `--slow`, `--plan`) and env vars (`PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`)"
  - "Configure roles interactively via `/model` selector and persist assignments to settings"
- `docs/models.md`
  - role aliases like `pi/smol` expand through `settings.modelRoles`
  - role values can include thinking suffixes like `:minimal|low|medium|high`
  - role targets may be concrete `provider/modelId` or canonical model ids
  - selection and fallback are model-driven, not role-driven

## Problem

Need stable names for intent, not concrete model ids.

Desired user abstraction:

- profile = environment / policy set
  - examples: `work`, `personal`, `openai`, `local`
- role = purpose / latency-cost-quality bucket
  - examples: `default`, `small`, `workhorse`, `smart`
  - canonical small-model role name: `small`
  - inspired by oh-my-pi `smol`
- callers should ask for role, not concrete model
  - example: render extraction says `small`
  - user can swap underlying model per profile later without code changes

## Pure-extension design options

### Option A - dedicated extension config file

Best pure-extension fit.

- global: `~/.pi/agent/model-profiles.json`
- project: `<cwd>/.pi/model-profiles.json`
- commands/UI:
  - `/profile`
  - `/role`
  - `/model-profiles`
- flags:
  - `--profile <name>`
  - `--role <name>`
- env:
  - `PI_MODEL_PROFILE`
  - `PI_MODEL_ROLE`
- session persistence via custom entries:
  - active profile
  - active role
- shared resolver helper:
  - `resolveModelRole({ profile, role, currentModel, modelRegistry, cwd })`

Pros
- zero fork
- no race with Pi settings writes
- easy mental model
- mirrors preset extension pattern

Cons
- settings live beside Pi settings, not inside them
- built-in `/model` remains separate universe

### Option B - extension-owned keys inside Pi `settings.json`

Possible, but more fragile.

- extension manually reads/writes:
  - `~/.pi/agent/settings.json`
  - `<cwd>/.pi/settings.json`
- store keys like:
  - `activeModelProfile`
  - `modelProfiles`
- extension still uses its own commands/UI

Pros
- single config file with other Pi settings
- closer to future core migration path

Cons
- no public generic settings setter for unknown keys
- no public exported file-lock helper
- extension must own raw JSON edits and write discipline
- still no built-in `/model` integration

### Option C - hybrid

Recommended if you want future migration path.

- source of truth for mappings:
  - `model-profiles.json`
- optional mirrors into session or known Pi settings:
  - session custom entries for active selection
  - maybe set `defaultProvider/defaultModel/defaultThinkingLevel` when activating a profile for future new sessions

Pros
- pure extension
- low risk
- can later migrate into Pi core schema cleanly

Cons
- slightly more moving pieces

## What does not fit extension-only v1 cleanly

- built-in `/model` selector integration
- core startup / restore resolution automatically honoring roles everywhere
- exact oh-my-pi alias syntax like `pi/smol` across all Pi internals
- first-class typed `SettingsManager` support for profile/role keys

Something strange is afoot if we pretend pure extension can do those *natively*. It can emulate a lot, but not truly own core model resolution.

## Recommended v1 boundary

Implement as pure extension-local system, not Pi core clone.

Scope:

- `pi/extensions/model-profiles/index.ts`
- `pi/extensions/model-profiles/config.ts`
- `pi/extensions/model-profiles/resolve.ts`
- `pi/extensions/model-profiles/ui.ts`
- config merge for global + project profile files
- resolver library reusable by `answer`, `render`, tests
- commands/flags/status widget for interactive use
- session persistence of active profile/role
- optional shortcut to open custom selector
- role fallback chain
  - explicit flag/env override
  - active session profile+role
  - profile default role
  - current session model
  - first available model

Keep role payload narrow:

- provider
- model
- thinkingLevel
- maybe ordered fallback candidates

Do **not** mix in tools/system prompt yet. Presets already cover that broader concern.

## Risks

- schema creep
  - profiles + roles + aliases + fallbacks + env overrides can sprawl fast
- overlap/confusion with presets
  - presets are broader; model-profiles should stay model/thinking focused
- persistence ambiguity
  - config assignment vs session-active selection are different things
- auth gaps
  - resolved target may exist but lack credentials; resolver must degrade predictably
- testing split
  - pure resolver tests easy; interactive command/UI tests harder
- package dependency awkwardness
  - repo currently leans on globally installed Pi package for extension typing/runtime
- settings write races if using Option B
  - extension and Pi can both write settings.json
- model switch semantics
  - current public extension API has `setModel`, not `setModelTemporary`
  - role switches in pure extension likely become normal session model changes

## Open questions

- name: `model-profiles` vs `model-roles` vs both?
  - gut: extension name `model-profiles`; core nouns inside are `profiles` + `roles`
- default built-in role set?
  - `default`, `small`, `workhorse`, `smart` only
  - or also `plan`, `commit`
- should role values support one fallback target or ordered candidate list?
- should active profile be persisted globally, per project, or only per session?
- should render extraction always use configured `small`, or allow per-feature override map later?
- do you want explicit compatibility target with oh-my-pi naming (`smol`, `slow`) or your preferred naming only?

## Recommendation for plan phase

Plan around extension-only v1 in this repo:

- `pi/extensions/model-profiles/core.ts`
- `pi/extensions/model-profiles/config.ts`
- `pi/extensions/model-profiles/index.ts`
- tests for config merge + resolver behavior
- then wire `render` integration harness to ask for `small`

If you want exact `/model` + `settings.json` integration later, treat that as Pi core follow-up, not this extension.