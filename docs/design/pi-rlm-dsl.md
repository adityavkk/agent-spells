# pi-rlm DSL specification

Status: Proposed
Parent design: [pi-rlm design](pi-rlm.md)

## Cell model

The guest language is ES2023 JavaScript. Each `rlm_eval` call submits one cell. The runtime parses the cell, rewrites its last expression as the return value, and executes it as a strict async function. This provides top-level `await` without using QuickJS modules.

Lexical declarations are cell-local. A `const` or `let` from cell 1 is not visible in cell 2. Cross-cell values must be written under `state`, which is a JSON object. Every cell receives a fresh QuickJS context. The runtime disposes the context afterward, so `globalThis` assignments and intrinsic or prototype changes cannot reach another cell. This rule avoids hidden realm state during restart replay.

At cell completion, the runtime validates that `state` contains only `JsonValue`. Functions, promises, handles, cycles, `undefined`, non-finite numbers, `bigint`, symbols, and class instances are rejected. Context and artifact IDs may be stored as strings and reopened through their APIs.

The parser rejects imports, exports, dynamic import, top-level return, and direct eval. The guest has no `Date`, timers, or `Math.random`. The host may expose an explicitly seeded `random()` function in a later DSL version.

## Core types

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ModelSelector =
  | { tier: "small" | "medium" | "large" }
  | { model: string; thinking?: ThinkingLevel };

type JsonSchema = Record<string, JsonValue>;

type CallErrorCode =
  | "FAILED"
  | "DENIED"
  | "CANCELLED"
  | "INTERRUPTED"
  | "TIMED_OUT"
  | "TURN_BUDGET_EXHAUSTED"
  | "TOOL_BUDGET_EXHAUSTED"
  | "ACCEPTANCE_FAILED"
  | "INVALID_REQUEST"
  | "INVALID_RESULT"
  | "UNAVAILABLE_CONTEXT"
  | "SOURCE_CHANGED"
  | "UNKNOWN_EFFECT"
  | "BUDGET_DEPTH"
  | "BUDGET_FRAMES"
  | "BUDGET_CALLS"
  | "BUDGET_ATTEMPTS"
  | "BUDGET_TOKENS"
  | "BUDGET_BYTES"
  | "BUDGET_DEADLINE";

type CallResult<T> =
  | {
      ok: true;
      value: T;
      callId: string;
      usage: CallUsage;
      outputRef?: string;
      cached: boolean;
    }
  | {
      ok: false;
      error: { code: CallErrorCode; message: string; retryable: boolean };
      callId: string;
      usage: CallUsage;
      outputRef?: string;
      cached: boolean;
    };

interface CallUsage {
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs: number;
}
```

Invalid guest specifications throw a guest-catchable error:

```ts
interface RlmDslError extends Error {
  name: "RlmDslError";
  code: "INVALID_SPEC" | "DUPLICATE_KEY" | "KEY_IDENTITY_CHANGED" | "INVALID_STATE" | "UNAWAITED_WORK";
  details?: Record<string, JsonValue>;
}
```

After a valid keyed specification is normalized, the broker allocates a deterministic `callId`. Child failures, denial, unavailable integrations, and resource preflight gates return `CallResult` with that ID. Each `BUDGET_*` result is non-retryable unless a user raises the run limit. User denial returns `DENIED`.

CPU, heap, worker termination, journal corruption, or a closed cell epoch fails the cell with a host `RlmInterpreterError`; guest code cannot catch it. Its persisted code is `CPU_LIMIT`, `HEAP_LIMIT`, `WORKER_EXIT`, `JOURNAL_CORRUPT`, `LATE_CALLBACK`, or `UNHANDLED_REJECTION`.

## Globals

```ts
interface RlmGlobals {
  readonly objective: string;
  readonly input: ContextRef;
  readonly budget: BudgetView;
  readonly state: Record<string, JsonValue>;
  readonly console: Pick<Console, "log" | "warn" | "error">;

  llm<T = string>(spec: LlmSpec<T>): Promise<CallResult<T>>;
  agent<T = string>(spec: AgentSpec<T>): Promise<CallResult<T>>;
  recurse<T = JsonValue>(spec: RecurseSpec<T>): Promise<CallResult<T>>;
  phase(name: string): void;
  checkpoint(spec: CheckpointSpec): Promise<"approved" | "denied">;
  emit(event: ProgressEvent): void;
  answer(value: JsonValue): void;

  readonly artifacts: ArtifactApi;
  readonly tools: ToolApi;
}

interface BudgetView {
  readonly depth: number;
  readonly maxDepth: number;
  readonly logicalCallsUsed: number;
  readonly logicalCallsRemaining: number;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  readonly activeLeafCalls: number;
  readonly maxConcurrency: number;
  readonly reportedTokensUsed?: number;
  readonly reportedTokensReserved?: number;
  readonly reportedTokenLimit?: number;
  readonly storedBytesUsed: number;
  readonly storedByteLimit: number;
  readonly deadlineMs: number;
}

interface ProgressEvent {
  message: string;
  current?: number;
  total?: number;
  details?: Record<string, JsonValue>;
}

interface CheckpointSpec {
  key: string;
  prompt: string;
  details?: Record<string, JsonValue>;
  timeoutMs?: number;
}
```

`phase()` and `emit()` are journaled by cell ID and within-cell ordinal. Replay suppresses duplicate UI events. `checkpoint()` requires a stable key and reuses only the same prompt, details, policy, and input identity.

## Context API

A `ContextRef` is an immutable, content-addressed source or derived value. All source files are snapshotted by content at run start. A ref remains readable after the original file changes or disappears.

```ts
interface ContextRef {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly tokenEstimator: string;
  readonly mimeType: string;
  readonly sha256: string;

  read(options?: { offsetBytes?: number; lengthBytes?: number }): Promise<ContextRead>;
  lines(options: { startLine: number; count: number }): Promise<ContextRead>;
  grep(options: ContextGrepOptions): Promise<ContextMatch[]>;
  chunks(options: ContextChunkOptions): Promise<ContextRef[]>;
  provenance(): Promise<ContextProvenanceSegment[]>;
}

interface ContextRead {
  text: string;
  startByte: number;
  endByte: number;
  startLine?: number;
  endLine?: number;
  truncated: boolean;
}

interface ContextGrepOptions {
  pattern: string;
  syntax?: "literal" | "re2";
  caseSensitive?: boolean;
  maxMatches: number;
  contextLines?: number;
}

interface ContextMatch {
  text: string;
  line: number;
  startByte: number;
  endByte: number;
  contextId: string;
  provenance: ContextProvenanceSegment[];
}

interface ContextChunkOptions {
  targetTokens: number;
  overlapTokens?: number;
  maxChunks: number;
  boundary?: "line" | "paragraph" | "none";
}

interface ContextProvenanceSegment {
  contextId: string;
  derivedStartByte: number;
  derivedEndByte: number;
  transform: "snapshot" | "chunk" | "concat" | "derive" | "artifact" | "synthetic";
  parentContextId?: string;
  parentStartByte?: number;
  parentEndByte?: number;
  rootSource?: {
    path?: string;
    sha256: string;
    startByte: number;
    endByte: number;
    startLine?: number;
    endLine?: number;
  };
  synthetic?: { label: string };
}
```

Offsets are zero-based UTF-8 byte offsets. The runtime moves an end offset backward when needed to avoid splitting a code point. Lines are one-based. Reads preserve source newline bytes after UTF-8 decoding. Invalid UTF-8 and binary sources require an explicit decoder during ingestion.

`grep()` defaults to literal matching. `re2` uses RE2 syntax and has pattern-length and match-count limits. A match spanning concatenated segments carries every overlapping provenance segment. A match inside a synthetic separator has synthetic provenance and no root line citation.

`chunks()` returns refs in source order and never exceeds `maxChunks`; it throws rather than silently dropping a remainder. `concat()` creates explicit synthetic separator segments. `derive()` records transform metadata but has no root-source range unless the caller supplies parent refs through a future typed transform. The token estimate records the estimator ID and is not a provider billing guarantee.

Derived contexts use explicit APIs:

```ts
interface ContextStoreApi {
  derive(spec: { key: string; value: string | JsonValue; label?: string }): Promise<ContextRef>;
  concat(spec: { key: string; refs: ContextRef[]; separator?: string; label?: string }): Promise<ContextRef>;
  open(id: string): Promise<ContextRef>;
}

declare const contexts: ContextStoreApi;
```

`derive()` and `concat()` are content-addressed and subject to the total stored-byte limit. Their keys prevent accidental reuse with different inputs.

## Model and agent calls

```ts
interface CommonCallSpec {
  key: string;
  schema?: JsonSchema;
  timeoutMs?: number;
  retries?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, JsonValue>;
}

interface LlmSpec<T> extends CommonCallSpec {
  prompt: string;
  context?: ContextRef | ContextRef[];
  model?: ModelSelector;
  thinking?: ThinkingLevel;
}

interface AgentSpec<T> extends CommonCallSpec {
  agent: string;
  task: string;
  context?: ContextRef | ContextRef[];
  model?: ModelSelector;
  piContext?: "fresh" | "fork";
  cwd?: string;
  skills?: string[];
  turnBudget?: { maxTurns: number; graceTurns?: number };
  toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
  acceptance?: "auto" | "attested" | "checked" | "verified";
}

interface RecurseSpec<T> extends CommonCallSpec {
  objective: string;
  context: ContextRef | ContextRef[];
  profile?: string;
}
```

A stable key is unique within one run and one call kind. Reusing a key with a different normalized specification throws. Canonical normalization sorts object keys, rejects non-JSON values, and replaces each context or artifact handle with its content hash. The identity also includes model, thinking, schema, profile policy, source hashes, and DSL version.

A logical call consumes call budget only when no committed matching result exists. Concurrent duplicates share one promise and one reservation. A cache hit consumes neither logical-call nor attempt budget. Each provider, agent, retry, or schema-repair invocation consumes attempt and token reservations.

A logical key owns revisions numbered from zero. Automatic retries add attempts to the active revision. A manual TUI retry creates revision N+1 with `priorRevisionId`, invalidates the owning cell and every later cell, clears any final answer, and replays from cell 1. Calls in the replay select the highest committed revision for that key and identity. This is how the controller observes the new result. A mutating or unknown-effect revision requires approval. A diagnostic retry that does not invalidate cells is not supported.

When `schema` is present, the runtime accepts only a JSON value that validates against it. A plain model call uses provider structured output when available. Otherwise the prompt requires one raw JSON value. The parser accepts no Markdown fences or surrounding prose. One separately budgeted repair attempt is allowed by default.

### `agent()` adapter contract

The public `pi-subagents` v1 protocol does not accept context handles or response schemas. The adapter will:

1. Snapshot every supplied context and write a `0600` input manifest plus content files under the run directory.
2. Add absolute paths, hashes, byte sizes, and the required output contract to the delegated `task` string.
3. Set delegation `context` to `fresh` unless `piContext` says `fork`, and set `cwd` to the run project root unless overridden within the approved root.
4. Request artifact capture. The DSL does not expose the protocol's output-path controls.
5. Parse the final `output` as strict JSON when a schema is present, validate it, and spend a separate repair attempt when allowed.

An agent without a file-reading tool cannot consume non-inline context. The adapter fails preflight when a profile declares known capabilities. When capabilities are unknown, the user approves the named agent as an opaque capability and the adapter may still return `INVALID_RESULT`.

## Artifacts and tools

```ts
interface ArtifactRef {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType: string;
}

interface ArtifactApi {
  write(spec: {
    key: string;
    name: string;
    value: string | JsonValue;
    mimeType?: string;
  }): Promise<ArtifactRef>;
  open(id: string): Promise<ArtifactRef>;
  asContext(artifact: ArtifactRef, options?: { label?: string }): Promise<ContextRef>;
}

interface ToolApi {
  call<T = JsonValue>(spec: {
    key: string;
    name: string;
    input: Record<string, JsonValue>;
    schema?: JsonSchema;
    timeoutMs?: number;
    risk?: "mutating";
    externalIdempotencyKey?: string;
  }): Promise<CallResult<T>>;
}
```

Artifact writes are atomic and content-addressed. The same key and value returns the same artifact during replay. `tools.call()` is unavailable unless the profile allowlists the exact Pi tool name.

The host owns effect classification. Known built-in tools are classified as `pure`, `read`, or `mutating`. Unknown and extension tools are `opaque`. The guest `risk` field may elevate a call to mutating but may never lower host risk. Retry, approval, and crash recovery use the host classification. A mutating or opaque call is never retried after an unknown crash outcome without a provider-recognized `externalIdempotencyKey` or user approval.

## Concurrency and completion

Native `Promise.all` and `Promise.allSettled` provide fan-out and join behavior. The host scheduler limits active leaf work. `recurse()` creates a frame but does not hold a leaf slot while the child waits, so recursion works when `maxConcurrency` is one.

Every bridge call and guest job belongs to its creating cell epoch. Returning from the async cell closes that epoch. Any unsettled bridge work is cancelled and fails the cell with `UNAWAITED_WORK`; late callbacks fail with `LATE_CALLBACK`. State and answer commit only after the epoch is quiescent.

`answer(value)` records one final candidate and returns `void`. The broker rejects later bridge calls from that cell. At cell completion, the runtime commits the answer only if no calls from the frame remain unsettled and the value is valid JSON. A second `answer()` call fails the cell. Free-text model output never completes a frame.

## Example: semantic map and reduce

```js
phase("classify every chunk");
const chunks = await input.chunks({
  targetTokens: 6000,
  overlapTokens: 200,
  maxChunks: 24,
});

const mapped = await Promise.all(chunks.map(chunk => llm({
  key: `classify:${chunk.sha256}`,
  model: { tier: "small" },
  maxOutputTokens: 2000,
  prompt: "Return JSON counts by category.",
  context: chunk,
  schema: {
    type: "object",
    required: ["counts"],
    properties: {
      counts: { type: "object", additionalProperties: { type: "integer" } },
    },
  },
})));

const counts = {};
for (const result of mapped) {
  if (!result.ok) continue;
  for (const [name, count] of Object.entries(result.value.counts)) {
    counts[name] = (counts[name] ?? 0) + count;
  }
}
answer({ counts, failedChunks: mapped.filter(x => !x.ok).length });
```

## Example: recursive analysis and agent verification

```js
phase("recursive analysis");
const sections = await input.chunks({ targetTokens: 24000, maxChunks: 16 });
const analyses = await Promise.all(sections.map(section => recurse({
  key: `analyze:${section.sha256}`,
  objective: "Find inconsistent claims and preserve source provenance.",
  context: section,
  profile: "research",
  maxOutputTokens: 4000,
})));

const candidate = await artifacts.write({
  key: "candidate-findings",
  name: "candidates.json",
  value: analyses,
});
const candidateContext = await artifacts.asContext(candidate);

phase("independent verification");
const checked = await agent({
  key: `verify:${candidate.sha256}`,
  agent: "reviewer",
  task: "Verify each candidate against the source contexts. Cite contextId and line.",
  context: [candidateContext, ...sections],
  acceptance: "checked",
  maxOutputTokens: 8000,
  schema: {
    type: "object",
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["claim", "contextId", "line", "verdict"],
          properties: {
            claim: { type: "string" },
            contextId: { type: "string" },
            line: { type: "integer" },
            verdict: { enum: ["confirmed", "rejected"] },
          },
        },
      },
    },
  },
});
answer(checked.ok ? checked.value : { error: checked.error });
```

## Example: allowlisted Pi tool

```js
const found = await tools.call({
  key: "find-typescript-files",
  name: "find",
  input: { pattern: "*.ts", path: "src" },
  schema: {
    type: "array",
    items: { type: "string" },
  },
});
if (!found.ok) answer({ error: found.error });
else answer({ files: found.value });
```
