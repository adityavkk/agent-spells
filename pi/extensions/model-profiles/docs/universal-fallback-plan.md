# Universal Profile Fallback Plan

## Goal

Make `/profile personal:smart` behave like a native Pi model selection.

User picks one profile+role.
Pi uses that selection for normal chat turns.
If primary target fails with retryable provider/runtime errors, Pi transparently falls through to the next configured target.

No manual `/model` switching.
No per-feature special casing.
No separate fallback code in every extension.

## Expected behavior

### Primary UX

User commands:

- `/profile personal:smart`
- `/profile work:smol`
- `/profile writer`
- `/profile status`

After `/profile personal:smart`:

- active session shows `personal:smart` in footer
- Pi behaves as if one native model was selected
- underlying target list is hidden implementation detail
- normal chat turns use the selected profile role
- extension-driven calls also use the same active profile role when they opt into session model

### Runtime fallback behavior

Given role config like:

```json
{
  "smart": {
    "targets": [
      { "provider": "code-puppy", "model": "gpt-5.4", "thinkingLevel": "high" },
      { "provider": "wibey-anthropic", "model": "claude-opus-4-6" },
      { "provider": "code-puppy", "model": "claude-opus-4-6" }
    ]
  }
}
```

Expected request behavior:

1. try target 1
2. if target 1 succeeds, done
3. if target 1 fails with retryable failure, try target 2
4. if target 2 fails with retryable failure, try target 3
5. if all fail, surface final error to user with trace

Retryable failures:

- 429
- rate limit / throttling
- 500 / 502 / 503 / 504
- overload / temporarily unavailable
- timeout / connection reset / transient transport errors

Non-retryable failures:

- invalid auth that should have been caught preflight
- invalid model id
- unsupported parameter for that provider
- malformed request payload
- parse/semantic failures after a successful model response

### Session behavior

- active profile+role persists in session custom entry
- reopening same session restores active synthetic model selection
- manual raw `/model` override still possible
- manual raw `/model` override should show drift in footer
- re-running `/profile ...` reasserts managed profile role

### Native-feeling behavior

The user should experience this as normal Pi model selection, not as a feature-specific hack.

That means:

- one selected active model in session
- model cycling / session state stays coherent
- no answer/render-only fallback behavior
- provider fallback happens below normal prompt execution, not above it

## Current state

Implemented now:

- proper `model-profiles` Pi extension
- `/profile` UX
- session persistence
- preflight role resolution
- ordered `targets[]` per role
- synthetic native Pi provider:
  - `profiles`
- synthetic profile-role models like:
  - `profiles/personal:smart`
- provider-wrapper routing for normal Pi chat turns
- runtime fallback stream wrapper for synthetic provider traffic
- runtime fallback helper for extension-controlled call sites
  - `answer`
  - `render` harness

Still missing / remaining:

- operator-friendly runtime diagnostics in `/profile status`
- optional fallback notifications
- live smoke verification inside an interactive Pi session
- README polish / status output examples after diagnostics land

## Why current approach is insufficient

Today fallback is wired only where this repo manually calls model APIs.

That means:

- `answer` can fall through
- `render` harness can fall through
- normal Pi conversation turns cannot yet fall through automatically

So current behavior is not truly universal.

## Proposed architecture

Implement universal fallback as a provider-wrapper extension.

### Core idea

Register synthetic Pi models via `pi.registerProvider(...)`.

Pi sees ordinary models.
Extension maps those synthetic models to profile roles.
Synthetic provider owns runtime fallback and retry behavior.

### Synthetic provider

Recommended synthetic provider name:

- `profiles`

Synthetic model ids:

- `personal:smol`
- `personal:workhorse`
- `personal:smart`
- `personal:writer`
- `work:smol`
- `work:workhorse`
- `work:smart`
- `work:writer`

Then `/profile personal:smart` can simply call:

- `pi.setModel(profiles/personal:smart)`

Pi core now believes a single model is active.
The extension/provider wrapper handles actual target selection and fallback.

### Provider wrapper responsibilities

`profiles` provider `streamSimple` should:

1. parse synthetic model id into profile+role
2. load current merged model-profiles config
3. resolve ordered targets for that role
4. for each target:
   - locate real model in registry
   - resolve auth/headers
   - execute request against real provider/model
   - if success, stream result through
   - if retryable failure, try next target
   - if non-retryable failure, stop
5. return final success or final surfaced error

### Config model

Keep current config model under `model-profiles.json`.
No new user-facing config file.

Role shape remains:

```json
{
  "targets": [
    { "provider": "code-puppy", "model": "gpt-5.4", "thinkingLevel": "high" },
    { "provider": "wibey-anthropic", "model": "claude-opus-4-6" }
  ]
}
```

Legacy single-target config remains supported:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.4-mini",
  "thinkingLevel": "minimal"
}
```

## Implementation plan

### Slice 1 - synthetic provider spec + model generation

Status: implemented

Files:

- `pi/extensions/model-profiles/provider.ts`
- maybe `pi/extensions/model-profiles/provider.test.ts`

Work:

- derive synthetic models from merged config
- map each `profile:role` to synthetic model definition
- register provider `profiles`
- preserve reasoning metadata conservatively
  - if any target reasons, synthetic model can reason
- define synthetic model ids in stable format

Verify:

- provider registered in Pi model registry
- synthetic models discoverable
- `/model` shows synthetic profile models if desired

### Slice 2 - runtime fallback stream wrapper

Status: implemented

Files:

- `pi/extensions/model-profiles/provider-runtime.ts`
- tests

Work:

- implement request execution against ordered real targets
- classify retryable vs non-retryable failures
- try next target on retryable failure
- propagate final streaming/result shape Pi expects
- attach trace metadata for logs/debugging

Verify:

- unit tests for 429/5xx retry
- unit tests for non-retryable stop
- unit tests for target exhaustion

### Slice 3 - bind `/profile` to synthetic models

Status: implemented

Files:

- `pi/extensions/model-profiles/index.ts`
- tests if practical

Work:

- when selecting `profile:role`, set model to synthetic provider model
- thinking behavior:
  - profile role should use target-level thinking on whichever concrete target runs
  - avoid conflicting top-level session thinking where possible
- footer still shows `profile:role`, not provider internals

Verify:

- `/profile personal:smart` sets synthetic active model
- status remains coherent
- session restore works

### Slice 4 - migration of extension-owned call sites

Files:

- `pi/extensions/answer/index.ts`
- `pi/extensions/render/*`

Work:

- simplify special-case fallback wrappers where possible
- extension-controlled call sites can still reuse common fallback code, but should align with provider-wrapper path
- avoid duplicated fallback logic diverging from provider wrapper

Verify:

- answer still works
- render harness still works
- behavior consistent with normal chat turns

### Slice 5 - diagnostics and operator UX

Status: next

Files:

- `pi/extensions/model-profiles/index.ts`
- maybe `docs/README` updates

Work:

- improve `/profile status`
- show active synthetic model + last resolved concrete target
- maybe show last fallback trace
- notify clearly when a fallback actually occurred

Verify:

- operator can tell what happened without noisy default UX

## Design details

### Failure classification

Keep classifier centralized.
One function used by provider wrapper and extension call sites.

Suggested default retryable matches:

- response/error text contains `429`
- `rate limit`
- `too many requests`
- `throttle`
- `503`, `502`, `504`, `500`
- `overloaded`
- `temporarily unavailable`
- `timeout`
- `connection reset`
- `econnreset`

### Thinking semantics

Need explicit policy.

Recommended:

- effective thinking comes from chosen concrete target entry
- if target entry omits `thinkingLevel`, treat as `off`
- do not silently inherit previous high reasoning across fallback boundaries

### Session semantics

Persist both:

- active logical selection: `profile`, `role`
- current synthetic model in session via normal Pi model change

Do not persist concrete fallback target as the official active selection.
That is runtime detail, not user intent.

### Footer semantics

Footer should continue showing:

- `personal:smart`
- `work:smol raw-override`
- `work:writer unresolved`

Do not show concrete fallback target in footer by default.
Keep that for status/debug output.

## Risks

### 1. Provider wrapper complexity

Streaming/provider wrapping is harder than preflight resolution.
Need to preserve Pi/`pi-ai` stream/result semantics exactly.

### 2. Double fallback logic drift

If provider wrapper and extension call sites each implement their own retry logic, behavior may diverge.
Need shared runtime module.

### 3. Thinking mismatch

Synthetic model capabilities may not perfectly reflect every concrete target.
Need conservative compat metadata.

### 4. Manual `/model` interaction

User can still select raw non-synthetic models manually.
Need clean drift detection and recovery.

### 5. Visibility vs noise

Fallbacks should be inspectable but not spammy.
Need quiet default, verbose status/debug.

## Acceptance criteria

Done means all of these are true:

- `/profile personal:smart` sets a synthetic native Pi model
- normal chat turns use role fallback automatically
- retryable provider failures fall through to next target automatically
- non-retryable failures do not fall through
- session restore preserves logical profile+role selection
- footer still shows logical profile+role only
- `/profile status` can show last resolved concrete target and fallback trace
- answer/render behavior remains compatible
- tests cover retryable and non-retryable runtime fallback behavior

Current acceptance status:

- done:
  - synthetic native model selection
  - universal provider-wrapper fallback path
  - retryable vs non-retryable behavior in tests
  - session restore alignment
  - footer keeps logical selection
- pending:
  - richer `/profile status` runtime diagnostics

## Non-goals

Not in this phase:

- replacing built-in `/model`
- changing Pi core source
- full cross-extension profile system beyond model/thinking
- global fallback across tools unrelated to model execution

## Recommendation

Implement this inside `pi/extensions/model-profiles` as a native Pi extension with a synthetic provider.

That gives the desired end-state UX:

- user picks `personal:smart`
- Pi behaves normally
- fallback happens automatically on runtime provider failures
- configuration stays declarative
- behavior feels native, not feature-specific
