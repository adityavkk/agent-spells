# pi-rlm TUI specification

Status: Proposed
Parent design: [pi-rlm design](pi-rlm.md)

## Inline run row

`rlm_run` renders one compact tool row. `Ctrl+O` uses Pi's normal tool expansion and shows code cells, call totals, usage, limits, warnings, and artifact paths.

```text
rlm  rlm_01J9  running  phase: independent verification
     frames 3  calls 18/64  active 6/8  failed 1  184k reported tokens  06:42
```

A completed row shows the typed output preview, completion mode (`answer` or `fallback_extract`), final reasoning preview, and one usage line. Intermediate call output does not enter the parent transcript or parent model context.

## Background widget

While any run is active, `ctx.ui.setWidget()` adds a widget above the editor.

```text
RLM runs  4 active, showing 3
> rlm_01J9  running    verify claims     12/18 calls  6 active  184k tok  06:42
  rlm_01JA  approval   edit repository    4/10 calls  agent worker requested
  rlm_01JB  draining   compare designs    8/12 calls  2 active
Ctrl+Alt+R inspect selected   /rlm runs show all   /rlm cancel <id>
```

The widget sorts approval requests first, then running, draining, and paused runs by most recent event. It shows at most three rows and an overflow count. The widget is display-only because it does not own editor focus. `/rlm inspect <id>` or `/rlm runs` changes the selected run. The shortcut opens the first approval request, otherwise the most recently active run.

At 80 columns, fields disappear in this order: cost, tokens, elapsed time, active count, objective preview. The run ID, state, progress count, and warning remain. Below 60 columns the widget becomes one summary line.

## Run navigator

`/rlm runs` opens a `SelectList` of active and recent runs. Each item includes state, objective preview, call progress, elapsed time, and warnings. Search matches run ID, profile, objective, state, agent, and model. Enter opens the inspector. Delete asks for confirmation and removes only terminal runs.

## Run inspector

`/rlm inspect <id>` or `Ctrl+Alt+R` opens a right-side overlay when the terminal is at least 100 columns wide. Narrow terminals use a full-screen custom component.

```text
RLM rlm_01J9  running  research profile                 184k / 500k reported tokens
[Summary] [Tree] [Calls] [Trajectory] [Variables] [Events] [Budget]

Frames and calls                         Selected call
> root                                  call verify:auth-routes
  + batch classify-all  14/16            kind       llm.batch
    + chunk 01  completed               model      gpt-5.6-luna:minimal
    + chunk 02  completed               state      running
    + chunk 03  failed                  attempt    1
  + recurse policies                    model      gpt-5.6-sol:xhigh
    + classify  completed               elapsed    00:41
    + verify    running                 attempts   1
  + synthesize  queued                  output     calls/.../result.json

j/k move  enter expand  tab view  p pause  P pause-now  u resume  r retry  f fork-retry  c cancel  o open  esc close
```

### Views

- **Summary:** program instructions, input and output fields, profile, phase, state, completion mode, final reasoning, typed output preview, warnings, and artifact paths.
- **Tree:** recursive frames and parent-child call relationships. Left and right collapse or expand a frame.
- **Calls:** sortable batches and calls with state, kind, key, agent or model, duration, tokens, attempts, order, and cache status.
- **Trajectory:** iteration, controller reasoning, accepted code, head-tail output preview, true output size, full output ref, error class, replay status, and final reasoning.
- **Variables:** named input descriptors, adapters, types, descriptions, constraints, head-tail previews, handles, provenance, hashes, sizes, workspace values, and redaction status. Enter opens a bounded source preview after any required approval.
- **Events:** filterable tail of typed lifecycle events. Raw payload opens only after confirmation when it contains source text.
- **Budget:** hard limits, reported limits, reservations, refunds, usage, stored bytes, and remaining capacity.

### Actions

- `p` requests normal pause. The header changes to `draining` until active calls finish.
- `P` requests pause-now and confirms that active agents will be cancelled rather than suspended.
- `u` resumes a paused run or reverses `pausing` before drain completes. It is disabled in every other state.
- `r` retries a selected retryable call only while its run is paused. It creates a new call revision, invalidates the owning and later cells, then replays them after resume. Mutating or unknown-effect calls require confirmation.
- `f` on a failed run creates a new run with `priorRunId`, copies the immutable program and source snapshots, and reuses only eligible committed read-only call records. The failed run remains unchanged.
- `c` cancels the selected call when a call row has focus, or the run when the root has focus. Run cancellation always confirms.
- `o` opens an artifact or context preview. Missing, evicted, or denied content produces an inline error and leaves the inspector open.
- `a` focuses the oldest approval request in the selected run.

The component uses Pi's configured keybinding manager where a corresponding app action exists. The extension registers `Ctrl+Alt+R` only when unclaimed. Slash commands remain the fallback for terminals that cannot send the chord.

## Approval dialog

TUI mode uses a centered overlay:

```text
RLM capability request

Run:       rlm_01JA
Objective: Apply the selected refactor
Requested: opaque agent capability [worker]
Context:   project source snapshots, 1.8 MiB
Limits:    24 calls, 4 concurrent, 150k reported tokens
Risk:      pi-subagents v1 cannot prove this agent is read-only

[v] view generated cell   [a] approve this run   [d] deny
```

Approval records the exact capability, source hashes, limits, agent name, and generated cell hash for this run. Version 1 never persists approval for an opaque agent because delegation v1 cannot prove its effective capabilities. Project policy cannot silently widen a global deny.

Denial resolves the bridge call with `DENIED`. Timeout does the same. Neither appears as a successful empty result.

RPC mode uses `ctx.ui.confirm()` with the same text and timeout so Pi's built-in extension UI protocol owns request correlation. JSON and print modes cannot prompt and deny unresolved requests.

## Control contract

The command handlers, TUI actions, and `rlm_control` tool call one typed coordinator API:

```ts
interface RlmControlRequest {
  version: 1;
  action: "list" | "status" | "inspect" | "pause" | "pause_now" | "resume" | "cancel" | "retry" | "fork_retry";
  runId?: string;
  callId?: string;
  expectedRevision?: number;
  inspect?: Omit<RlmInspectRequest, "version" | "runId">;
}

interface RlmControlResult {
  version: 1;
  ok: boolean;
  status?: RlmRunStatus;
  runs?: RlmRunStatus[];
  confirmationId?: string;
  newRunId?: string;
  inspection?: RlmInspectResult;
  error?: { code: string; message: string };
}

interface RlmRunStatus {
  runId: string;
  priorRunId?: string;
  state: string;
  sequence: number;
  program: { name?: string; instructionsPreview: string; inputCount: number; outputNames: string[] };
  profile: string;
  phase?: string;
  iteration?: number;
  maxIterations: number;
  elapsedMs: number;
  completionMode?: "answer" | "fallback_extract";
  finalRef?: string;
  originSessionId: string;
  calls: { total: number; active: number; failed: number; limit: number };
  frames: { total: number; active: number; limit: number };
  usage: { reportedTokens?: number; reservedTokens?: number; tokenLimit?: number; costUsd?: number };
  warnings: string[];
}
```

`list` needs no run ID. `status`, `inspect`, pause, resume, cancel, and `fork_retry` require a run ID. `inspect` also requires the matching inspect payload. `retry` requires a paused run ID, call ID, and the revision currently shown by the caller. A revision mismatch returns `STALE_REVISION`. Destructive actions may return `confirmationId`; TUI and RPC resolve it through the approval broker. JSON and print fail with `APPROVAL_REQUIRED` instead of prompting.

Action eligibility is fixed:

| Run or call state | Allowed actions |
|---|---|
| `running` | pause, pause-now, cancel |
| `pausing` | resume, pause-now, cancel |
| `paused` | resume, cancel |
| `awaiting_approval` | cancel or resolve approval |
| retryable terminal call in paused run | retry |
| failed run | fork-retry, status, delete through `/rlm runs` |
| completed or cancelled run | status; delete through `/rlm runs` only |

## Inspector query contract

The inspector does not rely on aggregate status. It requests committed, paginated projections:

```ts
interface RlmInspectRequest {
  version: 1;
  runId: string;
  view: "summary" | "tree" | "calls" | "trajectory" | "variables" | "events" | "budget";
  frameId?: string;
  cursor?: string;
  pageSize?: number;
}

interface RlmInspectResult {
  version: 1;
  runId: string;
  sequence: number;
  view: RlmInspectRequest["view"];
  items: JsonValue[];
  nextCursor?: string;
  final?: {
    outputs: Record<string, JsonValue>;
    completionMode: "answer" | "fallback_extract";
    finalReasoning: string;
    trajectoryRef: string;
  };
  error?: { code: string; message: string };
}
```

The first page captures the current committed event `sequence`. Its opaque cursor encodes run ID, view, captured sequence, filter hash, and last stable sort key. Later pages fold only events through that captured sequence, so active-run updates cannot duplicate or skip items. A cursor used with another run, view, filter, or compacted snapshot returns `INVALID_CURSOR`. Page size defaults to 50 and is limited to 1 through 200.

Ordering is fixed: tree uses frame creation plus depth-first child order; calls use creation sequence then revision; trajectory uses iteration; variables use input declaration order then workspace commit sequence; events use event sequence; budget uses ledger sequence.

Each view folds only journal-committed payloads. Summary reads the persisted program and final record. Tree combines frame, batch, and call events. Trajectory reads committed trajectory entries. Variables reads adapter descriptors, snapshots, workspace commits, and provenance. Events pages the event journal. Budget folds reservations, refunds, and usage. The same query works through TUI, RPC, and `rlm_control` inspector actions.

## Completion and attention

A completed background run updates its transcript entry when the origin session and branch still match. Otherwise the widget and `/rlm runs` show `completed, undelivered`. Approval, budget exhaustion, unknown mutation effect, and delivery failure also call `ctx.ui.notify()` once. Repeated status events do not produce repeated notifications.

## Rendering implementation

- Use `renderCall` and `renderResult` for the transcript row.
- Use `ctx.ui.setWidget()` for background summaries.
- Use `SelectList` for `/rlm runs` and `SettingsList` for `/rlm config`.
- Use `ctx.ui.custom(..., { overlay: true })` for the inspector and TUI approval dialog.
- Use `Text`, `Container`, `DynamicBorder`, and `highlightCode()` before adding custom widgets.
- Cache rendered lines by width and event sequence.
- Call `tui.requestRender()` after projection changes.
- Apply `truncateToWidth()` to every line.
- Rebuild pre-colored text during `invalidate()`.
- Keep event folding and action eligibility in pure functions so tests do not require a terminal.

The extension does not write terminal codes or ad hoc status text in RPC, JSON, or print modes. `rlm_control` returns the versioned status object. Foreground tool updates carry progress through Pi's normal tool event stream.

## TUI tests

Snapshot renderers at widths 50, 60, 80, 100, 120, and 180. Test zero, one, three, and more than three active runs. Test long instructions, many named variables, long paths, head-tail previews, ordered batch children, fallback completion, missing usage, nested depth greater than the visible tree, unknown events, theme invalidation, shortcut conflict, selection, action eligibility, each confirmation path, and artifact-open failure.
