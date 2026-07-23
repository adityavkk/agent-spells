# pi-rlm execution runtime

Status: Proposed
Parent design: [pi-rlm design](pi-rlm.md)
Prompt contract: [pi-rlm prompt architecture](pi-rlm-prompts.md)

## Frame isolation

Each RLM frame receives its own one-response controller driver, QuickJS worker, committed typed `workspace`, stdout buffer, and objective. Each cell gets a fresh QuickJS context inside that worker. Child frames receive immutable context handles and the shared run ledger. They do not inherit the parent's model messages or guest workspace.

### Interpreter backend protocol

The coordinator depends on a small owned backend contract:

```ts
interface RlmInterpreterBackendV1 {
  readonly protocolVersion: 1;
  readonly capabilities: {
    language: "javascript";
    contextMode: "fresh-per-cell";
    asyncHostCalls: true;
    deterministicGlobals: true;
    hardMemoryLimit: true;
    hardCpuInterrupt: true;
  };
  start(frame: InterpreterFrameConfigV1): Promise<void>;
  execute(cell: InterpreterCellRequestV1): Promise<InterpreterCellResultV1>;
  shutdown(reason: string): Promise<void>;
}

type RlmInterpreterFactoryV1 =
  (frame: InterpreterFrameConfigV1) => Promise<RlmInterpreterBackendV1>;
```

The factory creates one backend per frame. The coordinator always shuts it down. `InterpreterFrameConfigV1` contains run, frame, program, resolved policy, backend identity, bridge transport, limits, and abort/deadline context. `InterpreterCellRequestV1` contains cell identity, source, immutable variable bindings, committed workspace, DSL version, and epoch token. `InterpreterCellResultV1` contains bounded output, workspace candidate, answer candidate, code errors, usage, and epoch closure state.

The coordinator rejects any backend whose exact V1 capabilities do not match before controller spend. A process or micro-VM may enforce CPU and memory outside the guest, but it must report that enforcement in its pinned backend identity. Python or persistent-heap semantics require a later protocol version with a separate replay contract. Version 1 does not expose caller-owned backend reuse because overlapping runs and durable replay require one owner and one policy identity.

### QuickJS backend

Version 1 pins `quickjs-emscripten` 0.32.0 with `RELEASE_ASYNC`. Each frame runs in a Node worker thread. The worker creates a fresh hardened QuickJS context for every cell, injects the program inputs, variable catalog, and a serialized copy of committed `workspace`, and disposes the context after commit or failure. The worker uses `evalCodeAsync()`, a memory limit, and an interrupt handler. After any host bridge promise settles, the broker schedules `runtime.executePendingJobs()` until the guest job queue is empty. The worker RPC serializes one guest-resume operation at a time to avoid host-await and guest-job deadlocks.[^quickjs]

A worker separates QuickJS CPU and crashes from Pi's main thread. It is not an operating system sandbox. A QuickJS, WASM, worker, or Node vulnerability could expose host authority. Privileged workflows require a later process, container, or micro-VM executor using the same broker protocol.

## Cell lifecycle

A cell moves through `received`, `validated`, `running`, and one terminal state: `completed`, `failed`, `interrupted`, or `cancelled`.

1. Parse and validate source.
2. Append `rlm.cell.accepted` with source hash and DSL version.
3. Transform the cell into one strict async function with last-expression capture.
4. Evaluate it in the frame worker.
5. Drain guest jobs and track every bridge promise under the cell epoch.
6. When the async function returns, close the epoch to new bridge calls. Drain guest jobs again.
7. If any cell-owned bridge promise remains unsettled, cancel it and fail the cell with `UNAWAITED_WORK`.
8. Reject unhandled rejections and any late callback into the closed epoch.
9. Validate the cell result and typed `workspace`.
10. Write the workspace payload, then append the terminal cell commit event.

The runtime saves cell source before evaluation. Workspace, cell return value, and an answer candidate commit only after quiescence. A failed cell leaves the prior committed workspace unchanged. The runtime never treats an accepted cell as completed without a terminal commit event.

## Controller program and trajectory

The controller `rlm_eval` tool accepts `{ reasoning, code }`. `reasoning` is a concise action rationale written for the trajectory, not hidden provider thinking. Each turn records an immutable trajectory entry with iteration, reasoning, code reference, output preview, original output length, full output reference, and typed error class. Cell output previews keep the head and tail and state the omitted character count.

The controller prompt uses three cache-aware layers. A versioned base defines the controller role, executable DSL, fresh-cell semantics, error taxonomy, and completion rules. A stable per-run prefix adds the normalized `RlmProgram`, variable descriptors, profile limits, model routes, and capability classes. A dynamic turn message adds the budget, workspace catalog, last observation, pending approvals or failures, and bounded trajectory window. Ambient declarations and readable tool docs come from the same schemas to prevent drift.

The normal Pi agent receives only explicit-launch guidance and the public `rlm_run` schema. A host-owned single-use launch grant, bound to the current host turn and session, is required before snapshots or spend. Unsolicited calls fail with `RLM_OPT_IN_REQUIRED`. It never receives the internal controller prompt. An optional skill may add program-design examples, not controller runtime instructions. Child frames reuse the base with a child objective and supplied handles but no parent messages or workspace. The extractor has a separate prompt and no guest DSL. The [prompt architecture](pi-rlm-prompts.md) is normative.

The controller driver accepts exactly one provider response and one `rlm_eval` tool call per iteration. It reconstructs the bounded message list from committed state instead of allowing `AgentSession.prompt()` to continue autonomously after a tool result. Phase 0 may use `AgentSession` only if a conformance spike proves a race-free stop after the first `turn_end`; otherwise the driver uses Pi's lower-level model interface. Free text, zero calls, or multiple calls spend the provider attempt but execute no cell.

The complete trajectory remains external. Each controller request gets a bounded recent window plus older entry metadata and artifact handles. The default controller-history ceiling is 128 KiB per provider request. Truncation reports original lengths. The workspace, not copied trajectory prose, carries exact intermediate values between cells.

## Determinism and replay

The guest has no wall clock, timers, random source, package loader, filesystem, network, process object, or environment. Model and agent results are nondeterministic inputs, so the journal records their committed values and identities.

Cross-process resume follows one algorithm:

1. Create a fresh worker with an empty initial `workspace`.
2. Replay completed cells from cell 1 in order.
3. Return committed bridge results when call identity matches.
4. Suppress already committed `phase`, `emit`, console, checkpoint, artifact, and final-output events by cell ID and within-cell ordinal.
5. Replay the last interrupted cell. Calls with committed results replay. Calls without a terminal result follow unknown-effect policy.
6. Continue with new controller turns.

The runtime does not restore a final `workspace` snapshot before replay. This prevents a cell such as `workspace.n = (workspace.n ?? 0) + 1` from applying twice. A workspace snapshot may later accelerate replay, but it must identify cell N and replay only cells after N.

A committed read-only call may replay or retry. A mutating call that was running when the process stopped becomes `unknown_effect`, not `failed`. It requires user resolution unless the external system recognizes the recorded idempotency key. Exactly-once remote effects are not promised.

## Iteration exhaustion and fallback extraction

`maxControllerIterations` counts controller provider responses that may produce a cell. The default is exactly 20 with no extra wrap-up turn. When iteration 20 ends without a valid answer, `onIterationLimit: "fail"` terminates the run as `failed` with reason `ITERATION_BUDGET_EXHAUSTED`.

With `onIterationLimit: "extract"`, the run enters `extracting`. The extractor has stable identity from program hash, extractor program version, resolved model, output schemas, and latest committed trajectory sequence. It runs over a deterministic bounded evidence projection containing the output contract, variable catalog, exact small workspace JSON, answer candidates, prior invalid submissions, and head-tail projections of referenced contexts or artifacts. Every projection reports true and omitted bytes. The scheduler atomically reserves one leaf slot, attempt, tokens, deadline, and output bytes. Reservation failure ends as `budget_exhausted` with the concrete `BUDGET_*` reason. A crash replays a committed extractor result or follows the read-only retry rule.

If required evidence was omitted, the extractor returns `FALLBACK_EVIDENCE_TRUNCATED` rather than guessing. Extractor output passes the same named output schemas as `answer()`. The final record includes `completionMode: "answer" | "fallback_extract"`. `finalReasoning` is the answering cell's reasoning for normal completion and extractor reasoning for fallback. Evaluations score fallback completion separately because it can conceal controller failure.

## Scheduler

The coordinator has two independent bounds:

- `maxFrames` limits live controller and recursive frames.
- `maxConcurrency` limits active leaf work: plain model attempts, delegated agent attempts, and Pi tool attempts.

`recurse()` checks depth, logical-call, and frame capacity without waiting. If no frame slot is available while its caller owns a live frame, it returns `BUDGET_FRAMES`. It does not queue behind another recursive frame and does not hold a leaf slot while its child runs. This prevents leaf-slot and frame-slot deadlocks when every live frame tries to recurse.

Controller provider requests count as leaf work even though they are not DSL logical calls. A budgeted model wrapper reserves a leaf slot, one attempt, output tokens, input estimate, timeout, and cost estimate before every controller provider request, then accounts from the assistant message usage. The slot covers only the provider request. It is released before the resulting `rlm_eval` tool executes, so a parent controller does not block child work.

The leaf scheduler is fair FIFO across frames. One frame may reserve at most half of available leaf slots when another frame is waiting. Cancellation propagates from run to frame to cell to bridge call to Pi model session, Pi tool, or delegation cancellation event.

Before asynchronous fan-out, the scheduler captures an immutable `RlmCallContext` in Node `AsyncLocalStorage`. It contains run, frame, cell, optional batch and item IDs, policy hash, resolved model route, ledger reference, deadline, abort signal, trace parent, and origin session. Every provider, delegated agent, recursive frame, retry, repair, and batch item must inherit it. Missing or mismatched context fails preflight. Context propagation is tested across concurrent and nested calls.

### Logical calls, attempts, and cache hits

- A unique uncached `llm`, `agent`, `recurse`, or `tools.call` consumes one logical call.
- A controller provider request, plain provider invocation, delegated child invocation, retry, or schema repair consumes one attempt.
- A committed cache hit consumes neither.
- Concurrent calls with one identity share one promise and one reservation.
- Reusing a guest key with a different identity fails before any reservation.

Retry count defaults to zero for agents and tools, and one for plain read-only model calls. A schema repair consumes an attempt and has a separate maximum of one. The run also has `maxAttempts`, so per-call retries cannot multiply without bound.

## Budget ledger

The run owns one ledger shared by every frame. Reservations are atomic.

Before launch, a call reserves:

- one logical call when uncached;
- one attempt;
- one leaf slot for a leaf attempt;
- its declared `maxOutputTokens` plus an input estimate;
- its timeout window;
- an estimated maximum returned byte count.

After completion, the runtime replaces token estimates with provider-reported usage and refunds unused reservation. It records both values. Provider usage may overshoot its reservation or arrive late. The runtime stops new launches when reported plus reserved tokens reaches the limit, but cannot interrupt a provider at an exact token boundary.

Delegation v1 reports tokens but not cost. A profile requiring enforceable cost rejects `agent()` calls. A provider without token reporting rejects runs whose policy marks the token ceiling `required`; otherwise the UI labels token usage `unmeasured`.

### Default limits

| Limit | Default | Enforcement |
|---|---:|---|
| Root depth | 0 | Definition |
| Maximum recursive depth | 3 | Hard before child creation |
| Live frames | 8 | Hard, recursive acquisition is non-blocking |
| Logical bridge calls | 64 | Hard tree-wide |
| Provider and agent attempts, including controller turns | 96 | Hard tree-wide |
| Active leaf calls | 8 | Hard semaphore |
| Calls created by one cell | 32 | Hard |
| Controller iterations per frame | 20 | Hard, then fail or enter extracting |
| QuickJS heap per frame | 64 MiB | Hard worker limit |
| CPU per guest resume | 5 seconds | Hard interrupt handler |
| Run wall time | 30 minutes | Hard deadline with 1 second tolerance |
| Cell stdout plus return value | 16 KiB | Head-tail preview plus full artifact pointer |
| Controller trajectory view per request | 128 KiB | Hard, older entries become metadata and handles |
| One context read | 256 KiB | Hard |
| One bridge output | 2 MiB | Hard, then artifact pointer |
| Final inline output | 200 KiB | Hard, then artifact pointer |
| Stored contexts, artifacts, and call outputs | 256 MiB | Hard tree-wide |
| Journal bytes | 32 MiB | Hard; large payloads go to artifacts |
| Total reported plus reserved tokens | 500,000 | Pre-call gate with bounded provider overshoot |
| Cost | Unset | Optional, only when every call reports price |

Profiles may lower limits without approval. Raising depth, calls, concurrency, stored bytes, token budget, or wall time requires an approval or a trusted global profile.

## State machines

The run reducer accepts only these transitions:

| Current | Event or action | Next |
|---|---|---|
| `queued` | no approval needed | `running` |
| `queued` | capability approval needed | `awaiting_approval` |
| `awaiting_approval` | approved | `running` |
| `awaiting_approval` | denied or disconnected | `failed` |
| `awaiting_approval` | cancel | `cancelled` |
| `awaiting_approval` | approval or wall timeout | `timed_out` |
| `running` | pause | `pausing` |
| `pausing` | active calls drained | `paused` |
| `pausing` | resume before drained | `running` |
| `paused` | resume | `running` |
| `running`, `pausing`, `paused`, or `extracting` | cancel | `cancelled` |
| Any nonterminal state | wall timeout | `timed_out` |
| `running` or `pausing` | final answer committed | `completed` |
| `running` | iteration limit with fail policy | `failed` with `ITERATION_BUDGET_EXHAUSTED` |
| `running` | iteration limit with extract policy | `extracting` |
| `extracting` | schema-valid extractor output | `completed` |
| `extracting` | extractor error or invalid output | `failed` |
| `running`, `pausing`, or `extracting` | fatal error | `failed` |
| `running`, `pausing`, or `extracting` | hard budget exhausted | `budget_exhausted` |

Terminal states never transition. A pause action atomically flips the run to `pausing` before the scheduler checks its next launch. This orders pause before any later launch request. In-place call revision retry is legal only while a run is paused. Retrying a failed run creates a new run with `priorRunId`, the same committed program and snapshots, and explicitly reusable read-only call records; the original terminal run remains immutable.

Frames use `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, or `budget_exhausted`. Parent completion waits for every owned child frame to become terminal. A failed child is a `CallResult` and does not fail the parent unless guest code or policy makes it fatal.

Calls use `queued`, `running`, `retry_wait`, `completed`, `failed`, `denied`, `cancelled`, `interrupted`, `unknown_effect`, `timed_out`, `turn_budget_exhausted`, `tool_budget_exhausted`, `acceptance_failed`, `invalid_request`, `invalid_result`, `unavailable_context`, or a `budget_*` state. Retry creates a new attempt under one call revision.

### Pause semantics

Normal pause stops new controller requests, frames, retries, and leaf launches. Active leaf calls drain and commit. Calls already queued remain queued. Budget reservations remain held. The run shows `pausing` in the event model and `draining` in user-facing text.

`pause --now` cancels active calls. Delegated agents receive the v1 cancellation event and normally become `cancelled`, because the protocol has no pause operation. Resume does not revive that child session. It can launch a new call revision only when policy permits and the user accepts unknown mutation risk.

## Persistence

Run data lives under:

```text
~/.pi/agent/rlm/projects/<project-hash>/runs/<run-id>/
  manifest.json
  status.json
  events.jsonl
  frames/<frame-id>/cells/<cell-id>.js
  frames/<frame-id>/workspaces/<cell-id>.json
  trajectory/<entry-sha256>.json
  calls/<call-id>/request.json
  calls/<call-id>/result.json
  contexts/<sha256>/meta.json
  contexts/<sha256>/content
  artifacts/<artifact-id>/<name>
  final.json
```

`events.jsonl` commit events are the durable source of truth. `status.json` is a rebuildable cache. Before any run event, the coordinator writes immutable `manifest.json` through temporary file, `fsync`, and atomic rename. It then appends and syncs `rlm.run.started` with the manifest SHA-256. A started event with a missing or mismatched manifest is journal corruption; a manifest without a started event is an orphaned run and may be deleted.

Payload commit order is:

1. Write a request, workspace, trajectory, result, or final payload to a temporary file, `fsync`, then rename it atomically.
2. Append its typed commit event with frame, iteration, cell, payload path, and SHA-256 to `events.jsonl`, then `fsync` the journal.
3. Rewrite `status.json` from the event fold.

`manifest.json` persists the normalized `RlmProgram`, resolved profile and policy hash, DSL version, launcher-guideline, controller, extractor, and prompt-rendering hashes, backend protocol and implementation identity, and every adapter ID, version, descriptor, and snapshot hash. Resume requires exact identities or an explicit migration that forks a new run.

A payload without a matching commit event is an orphan. Recovery verifies its hash. It may promote a complete read-only result with a `recovered` event. A mutating orphan becomes `unknown_effect`. A commit event with a missing or invalid payload fails the run as journal corruption. Crash-injection tests cover every write, `fsync`, rename, and append boundary.

Cell source files are append-only. Manifest, request, result, workspace, trajectory, final, and status records use atomic replacement. The run directory and text-bearing files use modes `0700` and `0600`.

Project files, globs, text, session messages, and upstream artifacts are snapshotted by content at ingestion. A glob records its sorted path list and every file hash. This makes restart deterministic. Session and out-of-project sources require approval because snapshots may contain secrets.

The default retention is 30 terminal runs and seven days per project. Running, paused, and approval-blocked runs are never evicted. Users can pin a run. Deleting a run deletes its unshared contexts; project-level content blobs use reference counts.

Pi stores only a `pi-rlm-run` custom entry with run ID, state, usage, and artifact pointers. Source and intermediate content stay outside Pi model context.

## Event contract

Every event contains `version`, `eventId`, `runId`, `timestamp`, and a monotonic `sequence`. Child events include `frameId`, `parentFrameId`, `depth`, and optional `cellId`, `callId`, and `attempt`.

Initial event families are:

```text
rlm.run.started | forked | awaiting_approval | running | pausing | paused | resumed | extracting
rlm.run.completed | failed | cancelled | timed_out | budget_exhausted
rlm.frame.queued | started | completed | failed | cancelled | timed_out | budget_exhausted
rlm.cell.accepted | started | completed | failed | interrupted | cancelled
rlm.workspace.committed | rlm.trajectory.committed
rlm.batch.queued | started | completed | failed
rlm.extractor.started | completed | failed
rlm.call.queued | started | updated | retry_scheduled | completed | failed
rlm.call.denied | cancelled | interrupted | unknown_effect | timed_out
rlm.call.turn_budget_exhausted | tool_budget_exhausted | acceptance_failed
rlm.call.invalid_request | invalid_result | unavailable_context
rlm.approval.requested | resolved | timed_out
rlm.budget.reserved | updated | refunded | exhausted
rlm.output.committed
```

Consumers ignore unknown fields and event names. The TUI rebuilds current state by folding these events and checks the result against `status.json`.

## Security and capabilities

QuickJS guest code has no ambient capability. The controller prompt tells the model to treat selected source text as data rather than instructions, but this is guidance rather than enforcement. Every host effect crosses a typed broker. The broker checks project trust, source policy, path containment, exact Pi tool allowlist, budget, and approval.

A `pi-subagents` agent name is an opaque capability. Delegation v1 does not expose its effective tools, extension tools, network access, or mutation behavior. Version 1 always requires interactive per-run approval before the first call to each named opaque agent with a given source set. A global or project profile cannot bypass this approval. JSON and print modes deny `agent()`. A TUI or RPC user may approve the manifest, then let the approved run continue in the background.

Prompts such as “do not edit” are guidance, not enforcement. A network-capable agent given project context can exfiltrate it. Direct built-in `tools.call()` classifications are host-owned. Unknown and extension tools are opaque and follow the same per-run approval rule.

Worktrees reduce edit conflicts. They do not isolate credentials, processes, network effects, or external services. Generated code stays inspectable. `--review-code` pauses before every new cell. Headless modes deny unresolved approvals.

## Run modes and completion delivery

- **TUI:** foreground or background. Custom overlay approvals and inspector are available.
- **RPC:** foreground or background while the RPC host remains alive. Approvals use Pi's built-in extension UI confirm protocol, not a custom overlay.
- **JSON and print:** foreground only. `background: true` is rejected. Unresolved approvals fail closed.

The extension never writes arbitrary text to stdout in JSON or RPC mode. Tool updates and results carry status details. `rlm_control` returns the same versioned status object in every mode.

A background run records its origin session ID, session file, branch ancestor entry, and tool call ID. Completion enters the current Pi session only when that session ID still matches and its active branch descends from the recorded ancestor. Otherwise the coordinator records an undelivered completion. The matching session shows it on the next `session_start`; other sessions see it through `/rlm runs`. The extension never injects a result into whichever session happens to be active.

## Compatibility baseline

Version 1 requires:

- Pi `@earendil-works/*` 0.80.10 or newer;
- `pi-subagents` 0.35.1 or newer for `agent()`;
- Node worker threads and WebAssembly support;
- `quickjs-emscripten` exactly 0.32.0 until compatibility tests approve an upgrade.

The repository's current `@mariozechner/*` 0.73.1 dependencies must be migrated before Phase 1 implementation. This is a tracked prerequisite, not an implicit compatibility promise.

`pi-subagents` remains optional. Runtime code uses erased type-only imports and a guarded dynamic import of `pi-subagents/delegation`. If the import fails, `agent()` is disabled. After a request is emitted, the adapter requires `started` within two seconds. No response produces `UNAVAILABLE_CONTEXT`; a started request uses the call timeout. The listener is registered before emit to avoid a synchronous response race.

[^quickjs]: `quickjs-emscripten`, [README sections on promises, `executePendingJobs`, Asyncify, memory limits, and interrupt handlers](https://github.com/justjake/quickjs-emscripten/blob/main/README.md).
