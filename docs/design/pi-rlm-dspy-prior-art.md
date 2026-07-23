# DSPy RLM prior art for pi-rlm

Status: Researched and adopted in the parent design
Parent design: [pi-rlm design](pi-rlm.md)

## Why this implementation carries extra weight

`dspy.RLM` is a first-party module in the canonical DSPy repository. DSPy is led by Omar Khattab, a coauthor of the RLM paper. The initial implementation originated in merged [DSPy pull request 9193](https://github.com/stanfordnlp/dspy/pull/9193). Later merged work added the current `SUBMIT` protocol in [pull request 9210](https://github.com/stanfordnlp/dspy/pull/9210), head-tail formatting in [commit d8fae34](https://github.com/stanfordnlp/dspy/commit/d8fae34bdb4e5735477c6d96f36e952a6361370a), and `SandboxSerializable` in [pull request 9411](https://github.com/stanfordnlp/dspy/pull/9411). The current module is covered by public documentation and a large test suite. This makes it stronger prior art than a standalone demonstration, although it is still marked experimental and is not the paper's reference implementation.

This review inspected DSPy `main` at commit [`96bae53`](https://github.com/stanfordnlp/dspy/tree/96bae53d458d300b2cab49a5ddf30087498df952). The primary sources were:

- [`dspy/predict/rlm.py`](https://github.com/stanfordnlp/dspy/blob/96bae53d458d300b2cab49a5ddf30087498df952/dspy/predict/rlm.py)
- [`CodeInterpreter`](https://github.com/stanfordnlp/dspy/blob/96bae53d458d300b2cab49a5ddf30087498df952/dspy/primitives/code_interpreter.py)
- [`PythonInterpreter`](https://github.com/stanfordnlp/dspy/blob/96bae53d458d300b2cab49a5ddf30087498df952/dspy/primitives/python_interpreter.py)
- [`REPLVariable`, `REPLEntry`, and `REPLHistory`](https://github.com/stanfordnlp/dspy/blob/96bae53d458d300b2cab49a5ddf30087498df952/dspy/primitives/repl_types.py)
- [`SandboxSerializable`](https://github.com/stanfordnlp/dspy/blob/96bae53d458d300b2cab49a5ddf30087498df952/dspy/primitives/sandbox_serializable.py)
- [DSPy RLM design guide](https://dspy.ai/diving-deeper/rlm/) and [API reference](https://dspy.ai/api/modules/RLM/). Current source and tests are authoritative where the public pages still show the removed constructor `interpreter=` API.
- [`tests/predict/test_rlm.py`](https://github.com/stanfordnlp/dspy/blob/96bae53d458d300b2cab49a5ddf30087498df952/tests/predict/test_rlm.py)

## How DSPy RLM works

### Typed program signature

An RLM is constructed with the same DSPy signature used by `Predict` or `ChainOfThought`, for example `"context, query -> answer"`. Input fields become sandbox variables. Output fields define the required names and types for `SUBMIT(...)`. The module can replace another DSPy inference strategy without changing the task contract.

This is better than a generic objective plus one untyped answer because the runtime knows:

- every input name, description, constraint, and type;
- every required output name and type;
- whether a submitted result is complete;
- which names conflict with interpreter globals or tools.

### Variable space and token space

DSPy sends the controller metadata for each input rather than the full value. `REPLVariable` contains name, type, description, constraints, total length, and a bounded preview. The actual value remains in one invocation's persistent interpreter session. Normal values are injected into Python, while `SandboxSerializable` values are serialized and reconstructed once. This is not evidence for durable host-backed handles or cross-process replay. Those are pi-rlm additions. The controller chooses what to print or send to a submodel.

The preview uses both the beginning and end of a long value. REPL output uses the same head-and-tail strategy and reports the original character count. This gives the controller evidence from both ends without hiding that content was omitted.

### Iterative controller program

Each loop iteration uses an ordinary `dspy.Predict` named `generate_action`. It receives variable metadata, immutable REPL history, and the current iteration number. It returns explicit `reasoning` and one Python code block. The result is appended as a typed `{reasoning, code, output}` entry.

The controller prompt tells the model to:

1. inspect before decomposing;
2. iterate in small steps;
3. verify surprising or empty results;
4. use code for locating and aggregation;
5. use submodels for semantic judgment;
6. submit only after observing outputs.

Those instructions are concrete enough to evaluate and optimize independently from the task.

### Plain and batched submodel calls

The interpreter receives:

- `llm_query(prompt)` for one call;
- `llm_query_batched(prompts)` for concurrent ordered calls;
- `SUBMIT(...)` for final typed output;
- user-provided tools normalized through `dspy.Tool`.

The batch implementation uses eight workers, preserves input order, and returns a per-item error string for ordinary LM failures. A lock protects one run-scoped call counter. Every prompt in a batch consumes one unit from `max_llm_calls`.

The controller and submodel are separate. `sub_lm` can use a cheaper model while the controller uses the configured DSPy model.

### Interpreter protocol and ownership

`CodeInterpreter` is a small protocol with `start()`, `execute(code, variables)`, `shutdown()`, and a mutable tool dictionary. An interpreter created by `interpreter_factory` belongs to one RLM invocation and is always shut down. A caller-owned interpreter may be reused sequentially but not across overlapping calls.

The default `PythonInterpreter` runs Pyodide WASM inside Deno. Read, write, environment, and network permissions are explicit allowlists. Host tools cross a JSON-RPC bridge. Interpreter process and protocol failures are terminal; submitted-code failures are recoverable and return to the controller loop.

### Custom input adapters

`SandboxSerializable` gives a complex input four hooks:

- serialize the host value;
- declare sandbox setup code;
- reconstruct the value under its input name;
- provide a short model-facing preview.

This lets a DataFrame enter the sandbox once and remain a DataFrame instead of becoming lossy prompt text.

### Typed completion and salvage

`SUBMIT(...)` returns a `FinalOutput`. DSPy checks that the result is an object, contains every output field, and parses each field to its declared type. Missing or invalid fields produce a recoverable error that the controller can fix on a later iteration.

If the controller reaches `max_iters`, a separate `extract` predictor reads variable metadata and REPL history, then produces the declared output fields. The result records `trajectory` and `final_reasoning` for inspection.

## What pi-rlm will adopt

### 1. `RlmProgram` replaces objective-only runs

The public contract becomes a typed program:

```ts
interface RlmProgram {
  version: 1;
  name?: string;
  instructions: string;
  inputs: Record<string, RlmInputField>;
  outputs: Record<string, RlmOutputField>;
  profile?: string;
}

interface RlmInputField {
  description: string;
  constraints?: string;
  source: RlmSource;
  adapter?: string;
  preview?: { maxChars?: number; strategy?: "head-tail" | "none" };
}

interface RlmOutputField {
  description: string;
  schema: JsonSchema;
}
```

`/rlm --source ... -- objective` remains shorthand. It compiles to one `context` input and one string `answer` output. `rlm_run` uses a discriminated request:

```ts
type RlmRunRequest =
  | { program: RlmProgram; background?: boolean }
  | {
      objective: string;
      sources: RlmSource[];
      profile?: string;
      outputSchema?: JsonSchema;
      background?: boolean;
    };
```

The complete program owns `profile`. The shorthand owns its top-level profile. Passing program and shorthand fields together is invalid. Compilation produces one `resolvedProfile`; the manifest and replay identities persist its normalized policy hash.

### 2. Named variables and a durable workspace

The controller sees a `variables` catalog containing name, type, description, constraints, byte length, token estimate, preview, and content hash. Guest code uses `inputs.<name>`. When a safe input name does not collide with a reserved DSL name, the runtime also creates a read-only top-level alias.

Cross-cell derived values live under `workspace`. It accepts JSON, context handles, and artifact handles. It replaces the earlier generic `state` name because it describes the RLM variable space more clearly. Each cell receives a fresh QuickJS context and a reconstructed workspace, so restart replay remains deterministic.

### 3. Input adapter protocol

`RlmInputAdapter` takes the useful part of `SandboxSerializable` without permitting arbitrary host access:

```ts
interface RlmInputAdapter {
  readonly id: string;
  readonly version: string;
  matches(source: RlmSource): boolean;
  snapshot(source: RlmSource, broker: SnapshotBroker): Promise<InputSnapshot>;
  describe(snapshot: InputSnapshot, field: RlmInputField): VariableDescriptor;
  mount(snapshot: InputSnapshot, guest: GuestMountBroker): Promise<GuestInputValue>;
}
```

Adapters are trusted package code. The runtime hashes their ID, version, snapshot, and descriptor into replay identity. Built-ins cover text, JSON, file sets, tables, artifacts, and Pi sessions. Large values remain host-backed handles. Adapter code does not receive unrestricted guest-to-host authority.

The guest contract is discriminated and executable:

```ts
type GuestInputValue = ContextInputRef | JsonInputRef | TableInputRef;

interface VariableRefBase {
  readonly kind: string;
  readonly descriptor: VariableDescriptor;
  asContext(): Promise<ContextRef>;
}

interface ContextInputRef extends VariableRefBase, ContextRef {
  readonly kind: "context";
}

interface JsonInputRef extends VariableRefBase {
  readonly kind: "json";
  get(pointer: string): Promise<JsonValue>;
  keys(pointer?: string): Promise<string[]>;
}

interface TableInputRef extends VariableRefBase {
  readonly kind: "table";
  readonly columns: ReadonlyArray<{ name: string; type: string }>;
  readonly rowCount: number;
  slice(offset: number, limit: number): Promise<ReadonlyArray<Record<string, JsonValue>>>;
  select(columns: string[]): Promise<TableInputRef>;
}
```

Text, file sets, artifacts, and sessions mount as `ContextInputRef`. JSON mounts as `JsonInputRef`. CSV, Parquet, and DataFrame-like snapshots mount as `TableInputRef`. Every method is a brokered, bounded, journaled read. `inputs` and generated aliases use `GuestInputValue`; only the one-context shorthand exposes `input: ContextRef`.

### 4. Interpreter backend protocol

The coordinator will depend on an `RlmInterpreterBackend`, not directly on QuickJS. Version 1 ships a QuickJS backend. A future Deno/Pyodide, Gondolin, container, or remote backend can implement the same lifecycle and capability contract.

The factory creates one backend per frame. The coordinator owns it and always shuts it down. Version 1 does not expose caller-owned interpreter reuse because that would complicate concurrent run isolation and durable replay.

### 5. Explicit `llm.batch()`

Native `Promise.all` remains available, but `llm.batch()` becomes the preferred bulk primitive. It:

- validates and reserves the complete batch before launch;
- counts every item against logical-call, attempt, and token limits;
- applies host concurrency;
- preserves input order;
- returns one typed `CallResult` per item;
- isolates ordinary item failures without hiding policy failures.

The whole batch has one stable key, and each item uses the global `llm` key namespace. Before launch, the broker classifies committed, coalesced, and uncached items, then atomically reserves logical calls and maximum first-attempt, token, and output resources only for uncached items. Failed preflight rolls back every reservation and consumes zero calls or attempts. An attempt is charged only when its provider invocation starts. Effective concurrency is the smaller of the batch value and profile limit.

The scheduler captures one immutable `RlmCallContext` in `AsyncLocalStorage` and propagates it to every item. It contains run, frame, cell, batch and item IDs, policy identity, resolved model route, budget ledger, deadline, abort signal, trace parent, and origin session. This follows DSPy's deliberate `contextvars.copy_context()` propagation across batch workers. It prevents child calls from escaping tracing or policy attribution.

This gives the TUI one phase-level batch plus ordered inspectable children.

### 6. Typed trajectory

Each controller iteration records:

```ts
interface RlmTrajectoryEntry {
  iteration: number;
  reasoning: string;
  cellId: string;
  codeRef: string;
  outputPreview: string;
  outputChars: number;
  outputRef?: string;
  error?: { class: "code" | "interpreter" | "policy"; code: string };
}
```

Previews use head-and-tail truncation and report the original size. Full output remains an artifact. The final result exposes `trajectoryRef`, `finalReasoning`, and `completionMode` without placing the complete trajectory in the parent Pi context.

### 7. Separate fallback extractor

When a controller reaches its iteration limit without valid `answer(...)`, the profile chooses:

- `extract`: run a separately versioned extractor against variable metadata and a bounded trajectory view;
- `fail`: end with `iteration_budget_exhausted`.

Extracted output must pass the same output schemas. It receives its own model, attempt, token, time, and output reservation. The result records `completionMode: "fallback_extract"`, so evaluations can score normal and salvaged runs separately.

### 8. Controller prompt as a versioned program

Controller instructions become a versioned source artifact generated from:

- the `RlmProgram` contract;
- the executable DSL schema;
- variable descriptors;
- profile limits and models;
- available tools and capability classes.

This avoids stale hand-written docs. DSPy's current source still contains older `FINAL` wording in comments while the public runtime uses `SUBMIT`; pi-rlm will generate its prompt reference and ambient declarations from one schema.

The default prompt adopts DSPy's explore, iterate, verify, use-code-for-structure, use-models-for-semantics, and submit-after-observation rules. Prompt variants remain separately testable.

### 9. Controller and extractor evaluation identity

DSPy exposes its action and extract predictors as independently optimizable modules. pi-rlm will give `ControllerProgram` and `ExtractorProgram` separate version hashes, prompt sources, model routes, and evaluation records. A promotion record contains benchmark set hash, quality and coverage metrics, p50 and p95 latency, tokens, cost, fallback rate, policy failures, and prior version. A prompt version becomes a profile default only after its configured benchmark gates pass.

### 10. Namespace validation

Program input names, output names, adapter bindings, tool names, and DSL globals are validated before spend. Names must be valid JavaScript identifiers when used as aliases. One executable global schema generates ambient declarations and alias eligibility. Reserved names include `objective`, `input`, `inputs`, `variables`, `workspace`, `budget`, `llm`, `agent`, `recurse`, `answer`, `phase`, `checkpoint`, `emit`, `contexts`, `artifacts`, `tools`, and `console`. Colliding input names remain available under `inputs` but do not receive top-level aliases.

### 11. Recoverable code errors and terminal interpreter errors

Syntax, reference, type, and submitted-result errors become trajectory entries and return to the controller for correction while the backend remains healthy. Worker exit, protocol corruption, heap exhaustion, and journal corruption remain terminal. This copies DSPy's useful distinction between `CodeExecutionError` and `CodeInterpreterError`.

## What pi-rlm will not copy

### Python as the only DSL

Python is strong for data processing, and a Deno/Pyodide backend may be useful later. Version 1 keeps JavaScript because Pi and its extensions are TypeScript, LangChain and Claude workflows use JavaScript, and async bridge calls map directly to promises.

### Arbitrary persistent heap as durable state

DSPy keeps one interpreter heap for one invocation. pi-rlm needs crash recovery and code-edit replay across processes. It will persist the typed workspace and content handles, not arbitrary closures, modules, or prototype changes.

### Only three limits

DSPy currently exposes iteration count, submodel call count, and output characters. The unmerged [production-readiness proposal 9289](https://github.com/stanfordnlp/dspy/issues/9289) calls out missing cost and time guardrails, named model routing, and depth greater than one. Current DSPy `main` does not implement those proposed APIs. pi-rlm retains its tree-wide depth, frame, logical-call, attempt, concurrency, token, cost, wall-time, and stored-byte policies.

### Full trajectory in every controller prompt

DSPy sends immutable REPL history back on each iteration. With 20 iterations and 10,000 characters per output, this can still grow materially. pi-rlm keeps the full trajectory externally and sends a bounded recent window plus summaries and handles. The prompt records the original size whenever it truncates an entry.

### Error strings as structured control data

DSPy batch calls encode ordinary LM failures as `[ERROR] ...` strings. pi-rlm uses discriminated `CallResult` objects, typed errors, and explicit policy exceptions. Prose is not parsed for runtime control.

### Silent equivalence between direct and salvaged completion

A fallback extractor is useful, but it can hide a controller that failed to finish. pi-rlm records completion mode and evaluates fallback outputs separately.

## Expected improvements to pi-rlm

These changes make the design better in five ways:

1. A saved RLM becomes a reusable typed program rather than a prompt plus ad hoc JSON.
2. The model gets a clear variable catalog and bounded previews before writing code.
3. Complex inputs gain adapters without widening the guest capability surface.
4. Batched semantic calls, trajectories, and fallback extraction become first-class runtime objects and TUI views.
5. QuickJS becomes one backend behind a lifecycle contract, so stronger or Python-oriented sandboxes can arrive without rewriting orchestration.

The downside is more versioned surface area. Program schemas, adapters, interpreter backends, controller prompts, and extractors all need compatibility tests and migration rules.
