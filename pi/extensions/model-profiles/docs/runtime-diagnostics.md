# Runtime Diagnostics

## Goal

Make universal profile fallback observable without polluting normal chat UX.

Current runtime policy:

- sticky round-robin cursor per `profile:role`
- each turn starts at current cursor
- fallback wraps through remaining targets
- winning target becomes next turn's cursor
- `/profile reset` clears cursor back to first configured target

Need answers to:

- which concrete target actually ran?
- did fallback happen?
- which targets failed first?
- were failures retryable or terminal?
- why did fallback stop?

## Expected behavior

### Default UX

Quiet by default.

Normal chat should not spam notifications every time a request succeeds on the first target.
Footer should continue to show only logical selection:

- `personal:smart`
- `work:writer`

### `/profile status`

Should include runtime diagnostics for the most recent profile-backed turn.

Target output shape:

```text
personal:smart model:profiles/personal:smart
resolved:code-puppy/gpt-5.4 thinking:high source:session
runtime:last=code-puppy/gpt-5.4 winner=wibey-anthropic/claude-opus-4-6
attempts:
- code-puppy/gpt-5.4 retryable-response-error 429 Too Many Requests
- wibey-anthropic/claude-opus-4-6 success
```

### Optional notification behavior

Only notify on actual fallback or terminal failure.

Examples:

- `Profile fallback: personal:smart code-puppy/gpt-5.4 -> wibey-anthropic/claude-opus-4-6`
- `Profile fallback exhausted: personal:smart after 3 targets`

Do not notify for ordinary first-target success.

## What to record

Recommended runtime diagnostic record:

```ts
interface ModelProfilesRuntimeAttempt {
  provider: string;
  model: string;
  status:
    | "auth-unavailable"
    | "retryable-response-error"
    | "retryable-throw"
    | "non-retryable-response-error"
    | "non-retryable-throw"
    | "success";
  message?: string;
}

interface ModelProfilesRuntimeDiagnostics {
  profile?: string;
  role?: string;
  syntheticModel?: string;
  winner?: {
    provider: string;
    model: string;
    thinkingLevel?: string;
  };
  attempts: ModelProfilesRuntimeAttempt[];
  fallbackCount: number;
  startedAt: number;
  finishedAt: number;
}
```

## Best integration point

Do not infer diagnostics from UI or final assistant messages.
Record them at the fallback runtime layer.

Primary integration point:

- `pi/extensions/model-profiles/runtime.ts`

Why:

- sees every candidate attempt
- knows retryable vs terminal decision
- knows eventual winner
- shared by direct complete path and provider stream path

## Recommended implementation

### 1. add callback hooks to runtime helper

Add optional callbacks to fallback helpers.

For example:

```ts
onAttempt?: (attempt) => void
onSuccess?: (candidate, attempts) => void
onFinalError?: (candidate, attempts, error) => void
```

Apply to:

- `completeWithModelRoleFallback(...)`
- `streamWithModelRoleFallback(...)`

Keep callback payloads small and serializable.

### 2. add extension-owned in-memory diagnostics store

Inside `pi/extensions/model-profiles/index.ts` keep something like:

```ts
let lastRuntimeDiagnostics: ModelProfilesRuntimeDiagnostics | null = null;
```

This is enough for first pass.

Why in-memory first:

- simple
- no session schema churn yet
- fits `/profile status`
- avoids writing noisy entries for every turn

### 3. pass diagnostics callbacks into synthetic provider stream

`provider.ts` already sits between synthetic model and concrete target execution.
Extend `createModelProfilesProviderStream(...)` input so it can receive hooks from `index.ts`:

```ts
createModelProfilesProviderStream(() => ({
  config,
  modelRegistry,
  onRuntimeDiagnostics: (diag) => { ... }
}))
```

Then when calling `streamWithModelRoleFallback(...)`, pass callbacks that build the final diagnostics object.

### 4. surface in `/profile status`

Extend `formatModelProfilesStateSummary(...)` or add a separate formatter:

- logical selection
- resolved synthetic selection
- winner concrete target
- ordered attempts
- terminal status

Keep footer unchanged.
Footer is not the place for detailed attempt traces.

### 5. optional notifications on actual fallback

In `index.ts`, after diagnostics arrive:

- if `fallbackCount > 0`, maybe `ctx.ui.notify(...)`
- if `attempts.at(-1)?.status !== "success"`, maybe warning/error notify

Guard with low-noise policy.

## Minimal code shape

### types

Add to `types.ts`:

```ts
export interface ModelProfilesRuntimeAttempt { ... }
export interface ModelProfilesRuntimeDiagnostics { ... }
```

### runtime hooks

Add to fallback helper input types:

```ts
onAttempt?: (attempt: ModelProfilesRuntimeAttempt) => void;
onFinish?: (diagnostics: ModelProfilesRuntimeDiagnostics) => void;
```

### provider bridge

In `provider.ts`:

- construct diagnostics seed from synthetic `profile:role`
- append attempts from runtime callbacks
- set `winner` on success
- call `onRuntimeDiagnostics(diagnostics)`

### status rendering

In `index.ts`:

- store last runtime diagnostics in closure
- include in `/profile status`
- maybe clear on `/profile reload` or model change if desired

## Current implementation

Implemented now:

1. sticky cursor stored per `profile:role`
2. callbacks from `streamWithModelRoleFallback`
3. `/profile status` prints:
   - cursor
   - winner
   - attempts
4. footer model display shows last concrete winner
5. notification only when fallback actually happened

That gives strong operator visibility with minimal schema churn.

## Optional second pass

If you want diagnostics to survive session resume, persist a compact custom entry:

- custom type: `model-profiles-runtime-diagnostics`

But only persist compact summaries, not full per-token stream data.

Suggested persisted shape:

```json
{
  "profile": "personal",
  "role": "smart",
  "winner": "wibey-anthropic/claude-opus-4-6",
  "attempts": [
    { "ref": "code-puppy/gpt-5.4", "status": "retryable-response-error", "message": "429 Too Many Requests" },
    { "ref": "wibey-anthropic/claude-opus-4-6", "status": "success" }
  ],
  "finishedAt": 1760000000000
}
```

## Non-goals

Not recommended:

- per-token diagnostics in footer
- notifying on every successful first-target request
- mid-stream replay fallback after visible output was already emitted
- storing huge transient failure payloads in session history

## Summary

Best path:

- hook diagnostics into `runtime.ts`
- store latest diagnostics in `index.ts`
- expose through `/profile status`
- optional notify only on real fallback / exhaustion

That keeps the extension native-feeling, observable, and low-noise.
