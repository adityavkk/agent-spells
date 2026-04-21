# Resume/restartable subagents

## Why this matters

`pi-subagents` today is optimized for one-shot delegation.

It already persists child pi sessions, but the public API exposes only:
- execution inputs
- async run IDs for status inspection
- session file paths in some result/status details

Missing piece: a stable child-session handle that can be passed back in later to continue the same subagent.

## Main finding

Yes: pi should be able to support restartable/resumable subagents.

Not by reusing the current async run ID.

Instead:
- create a stable child session handle
- map it to a persisted pi session file
- later invoke subagent with `resumeSession` / `sessionHandle`
- internally launch child pi with `--session <existing-session-file>`

That would continue prior child context.

## Important distinction

Two IDs:

### 1. Async run ID
Current `pi-subagents` background ID.
Used for:
- `status.json`
- `events.jsonl`
- completion/result files
- `subagent_status`

This is an execution/job ID, not a conversation/session identity.

### 2. Child session handle
What we actually need for resume.
Should identify:
- persisted child conversation state
- reusable later by parent
- independent of any one foreground/background run

OpenCode already does this.

## OpenCode precedent

OpenCode `task` tool already supports resume.

Relevant files:
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/tool/task.txt`

Key API shape:
- optional `task_id`
- if provided, OpenCode loads that subagent session instead of creating a fresh one
- tool output always includes the `task_id` for later reuse

Relevant behavior from `task.ts`:
- tool params include `task_id?: string`
- code checks `sessions.get(task_id)`
- if found, resumes that session
- else creates new child session
- result includes `task_id: <session-id>`

Relevant guidance from `task.txt`:
- fresh context unless `task_id` supplied
- reused `task_id` continues previous messages and tool outputs

OpenCode also has follow-on work/bugs around:
- always returning the child session ID, even on failure/cancel
- validating session ownership on resume
- navigating child session trees
- distinguishing root sessions vs subagent sessions

## What pi-subagents already has

Current `pi-subagents` already supports most underlying mechanics.

### Session persistence exists

`buildPiArgs()` already supports:
- `--session <file>` via `sessionFile`
- `--session-dir <dir>` via `sessionDir`

Relevant file:
- `.tmp/repo-compare/pi-subagents-pi-args.ts`

### Sync path already accepts existing session file

`runSync()` accepts:
- `sessionFile?: string`
- `sessionDir?: string`

Relevant file:
- `.tmp/repo-compare/pi-subagents-execution.ts`

### Async runner also accepts existing session file

Runner step objects already carry `sessionFile`.

Relevant files:
- `.tmp/repo-compare/pi-subagents-async-execution.ts`
- `.tmp/repo-compare/pi-subagents-subagent-runner.ts`

### Current results/status often surface sessionFile

Async status/result tracking already records:
- `sessionFile`
- `sessionDir`

Relevant files:
- `.tmp/repo-compare/pi-subagents-async-status.ts`
- `.tmp/repo-compare/pi-subagents-subagent-runner.ts`

## So what is missing?

Mostly product/API plumbing.

### Missing public API
No current schema field like:
- `resumeSession`
- `sessionHandle`
- `resumeFrom`

### Missing stable handle return contract
Current tool returns:
- result text
- details
- `asyncId` for background

But no guaranteed reusable child session handle.

### Missing handle registry / ownership checks
Need a way to safely resolve:
- handle -> session file
- ensure resumed child belongs to same parent/root/project lineage

## Suggested pi-subagents design

### Tool input
Add one optional field:

```ts
resumeSession?: string
```

or

```ts
sessionHandle?: string
```

Semantics:
- if absent: create fresh child session as today
- if present: resolve handle to child session file and continue it

### Tool result/details
Always include:
- `sessionHandle`
- maybe `sessionFile` in details for debugging
- `asyncId` separately when backgrounded

### Failure behavior
Always return session handle even on:
- model failure
- cancellation
- child error
- timeout

This was important enough to become an OpenCode bug when missing.

### Security / validation
Do not accept arbitrary raw session files from the model by default.

Better:
- opaque handle
- internal registry maps handle -> session file
- validate it belongs to caller/root lineage

## What “restart” really means

Supported meaning:
- continue the prior child session from the last persisted state

Not the same as:
- resume an interrupted tool call in the middle
- restore transient in-memory state from a half-finished turn

So this is a session-level resume, not exact process checkpoint/restore.

## Async + resume

These should stay separate concepts:

- `asyncId`: inspect one background execution attempt
- `sessionHandle`: continue the subagent’s conversation later

Example desired flow:

### First call

```ts
subagent({
  agent: "scout",
  task: "Map auth system",
  async: true,
  clarify: false,
})
```

Tool returns details like:

```ts
{
  asyncId: "run-123",
  sessionHandle: "child-auth-scout-1",
}
```

### Later follow-up

```ts
subagent({
  agent: "scout",
  task: "Now focus on OAuth support",
  resumeSession: "child-auth-scout-1",
})
```

Internally:
- resolve handle -> session file
- spawn pi with `--session <that-file>`

## Concrete implementation sketch for pi-subagents

1. Extend `SubagentParams` schema with `resumeSession?: string`
2. Introduce a handle registry:
   - child handle
   - session file
   - agent
   - root parent session
   - cwd/project
   - timestamps
3. On fresh child session creation:
   - store handle mapping
   - include handle in result details
4. On resume:
   - resolve handle
   - validate ownership/lineage
   - pass `sessionFile` into existing sync/async paths
5. Ensure failure/cancel still emits handle
6. Keep `asyncId` unchanged for status inspection

## Caveats

### Current pi-subagents `cwd` / `worktree` are not sandboxes
Resume support would not change that.

### Interrupted-session recovery may need extra care
If child pi crashes mid-turn, persisted session may contain partially completed state.
A robust resume flow may need cleanup / recovery logic for incomplete last-turn artifacts.

OpenCode has analogous issues around orphaned pending/running state after restart.

## Bottom line

Resume/restartable subagents in pi look very feasible.

The key insight:
- reuse persisted child session state
- do not treat current async run ID as the resume handle

Current `pi-subagents` seems structurally close already.
The feature gap is mostly:
- schema
- handle contract
- registry
- validation
- consistent result surfacing

## References

### Pi / pi-subagents
- `./.tmp/repo-compare/pi-subagents-pi-args.ts`
- `./.tmp/repo-compare/pi-subagents-execution.ts`
- `./.tmp/repo-compare/pi-subagents-async-execution.ts`
- `./.tmp/repo-compare/pi-subagents-subagent-runner.ts`
- `./.tmp/repo-compare/pi-subagents-async-status.ts`
- `./.tmp/repo-compare/pi-subagents-subagent-executor.ts`

### OpenCode
- `/Users/auk000v/.search/github-repos/anomalyco/opencode/packages/opencode/src/tool/task.ts`
- `/Users/auk000v/.search/github-repos/anomalyco/opencode/packages/opencode/src/tool/task.txt`
- PR: `https://github.com/anomalyco/opencode/pull/7756`
- Issue: `https://github.com/anomalyco/opencode/issues/6584`
- Issue: `https://github.com/anomalyco/opencode/issues/13910`
- Issue: `https://github.com/anomalyco/opencode/issues/19023`
