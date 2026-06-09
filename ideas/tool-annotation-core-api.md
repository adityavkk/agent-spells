# Pi core API: tool annotations + inline streaming + per-row raw/lens toggle

Core follow-up for #12. Sibling extension design: `ideas/tool-analyzer-extension.md` (#11/#13).

This is a Pi-core design, not an `agent-spells` extension. The change lands in
`@mariozechner/pi-coding-agent` (and its `pi-tui` interactive mode). This repo
only consumes Pi, so this doc is the implementer-ready spec to hand upstream and
the contract `tool-lens` will target once it ships.

All constraints below were verified against the installed Pi dist
(`@mariozechner/pi-coding-agent@0.73.1`). Paths are `node_modules/@mariozechner/...`
unless noted; line numbers are from that build and will drift, so each cite also
names the symbol.

## Problem

`tool-lens` (#11) wants to stream analysis *inside* a tool row and let the user
flip that row between raw output and the lens view. Pi cannot express this today,
so #11 ships a hybrid (live HUD during execution + `custom_message` cards flushed
at idle). The hybrid is correct but compromised: the per-tool live moment lives in
a detached below-editor widget, permanence lives in an adjacent card, and the two
never become the single in-row raw/lens swap the UX actually wants.

The gap is structural, not cosmetic. Four independent Pi facts make the target UX
impossible from an extension:

1. **One renderer owns a row.** `ToolExecutionComponent` resolves the result
   renderer as `this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult`
   (`dist/modes/interactive/components/tool-execution.js`, `getResultRenderer()`).
   The only way to draw inside a tool row is to *be* that tool's `renderResult`.
2. **Tools are not introspectable enough to wrap.** `getAllTools()` returns
   `ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & { sourceInfo }`
   (`dist/core/extensions/types.d.ts`, `ToolInfo`). No handle to another tool's
   `execute`/`renderResult`, so a generic wrapper cannot delegate to arbitrary
   third-party tools. Co-owning a name is the only lever, and it conflicts with
   `provider-tool-profiles`, which already owns the provider tool names.
3. **A row has one view axis.** `ToolRenderContext` exposes `expanded` and nothing
   else (`dist/core/extensions/types.d.ts`, `interface ToolRenderContext`). There
   is no second toggle to mean "raw vs lens".
4. **Sessions are append-only and metadata cannot evolve in place.** The public
   surface is `appendMessage` / `appendCustomEntry` / `appendCustomMessageEntry` /
   `appendLabelChange` and friends (`dist/core/session-manager.d.ts`). There is no
   `editEntry`/`replaceEntry`; an entry's `content`/`details` are frozen at write.
   And the only transcript-injection path, `pi.sendMessage`, is queue-gated through
   steer/followUp and re-enters the agent loop (`getFollowUpMessages` ->
   `streamAssistantResponse` in `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`),
   costing an extra LLM turn unless deferred to idle.

Net: extensions cannot stream evolving, typed, per-tool metadata into a row, and
cannot persist it without either polluting/charging the LLM context or co-owning
the tool name. #12 closes that gap with a first-class annotation channel.

## Design goals

- Persist typed, per-`toolCallId` metadata that **never** enters LLM context by
  default and survives resume/fork/tree navigation.
- Let an extension **stream** annotation updates while a tool runs, with **no**
  extra LLM turn.
- Give renderers a **second view axis** (raw vs lens) independent of expand/collapse.
- Let **built-in and provider-profile** renderers opt into lens rendering without
  re-registering or replacing tools.
- Keep it backward compatible: every field is optional; today's renderers and
  sessions keep working untouched.

Non-goals: grading the agent, mutating tool inputs/outputs, a generic
third-party-tool wrapper, or a redaction/privacy layer (that stays in the
`tool-lens` extension, #11).

## Verified constraints (cite map)

| # | Claim | Verified at |
|---|-------|-------------|
| 1 | One renderer per row: `toolDefinition.renderResult ?? builtInToolDefinition.renderResult` | `tool-execution.js` `getResultRenderer()` |
| 2 | `getAllTools()` -> `ToolInfo` (name, description, parameters, sourceInfo) only | `core/extensions/types.d.ts` `ToolInfo`, `GetAllToolsHandler` |
| 3 | `ToolRenderContext` has only `expanded` (no view mode, no annotations) | `core/extensions/types.d.ts` `ToolRenderContext` |
| 4 | `ToolRenderResultOptions` = `{ expanded, isPartial }` only | `core/extensions/types.d.ts` `ToolRenderResultOptions` |
| 5 | Sessions append-only; no edit/replace of `content`/`details` | `core/session-manager.d.ts` (`append*`, `appendLabelChange`; no `editEntry`) |
| 6 | `pi.sendMessage` queue-gates via steer/followUp and triggers an extra turn | `core/extensions/types.d.ts` `sendMessage` (`deliverAs`, `triggerTurn`); `pi-agent-core/dist/agent-loop.js` followUp -> `streamAssistantResponse` |
| 7 | `appendCustomEntry` writes a `custom` entry that never enters context and only shows in tree-selector | `core/session-manager.d.ts` `appendCustomEntry`; `tool-analyzer-extension.md` rendering notes |
| 8 | `CustomMessageComponent` always prepends `new Spacer(1)` (no zero-height row) | `dist/modes/interactive/components/custom-message.js` constructor |
| 9 | No annotation API exists yet (`appendToolAnnotation`, `viewMode`, `ToolAnnotation` absent from dist) | grep over `dist/**/*.d.ts` |
| 10 | `tool_execution_start` fires in source order upfront; `_end` in completion order; `agent_end` once per batch | `tool-analyzer-extension.md` parallel section, verified against `agent-loop.js` `executeToolCallsParallel` |

## Proposed API

Four additive pieces. Nothing here is breaking; all new fields are optional.

### 1. Annotation store keyed by `toolCallId`

A new append-only-but-coalescing channel, distinct from session entries. It is
*not* an `AgentMessage`, so it never reaches `convertToLlm`/`context` and costs no
turn. It is persisted alongside the owning tool call so it survives resume/fork.

```ts
/** A typed, streamable annotation attached to one tool call. */
export interface ToolAnnotation<TData = unknown> {
  /** Owning tool call. */
  toolCallId: string;
  /** Writer namespace, e.g. "tool-lens". Multiple namespaces may coexist per call. */
  namespace: string;
  /** Lifecycle of this annotation's data. */
  phase: "streaming" | "final" | "error";
  /** Arbitrary structured payload. Schema is the writer's contract. */
  data: TData;
  /**
   * Optional JSON-schema-ish descriptor the writer may attach for validation /
   * debugging. Pi treats it as opaque; it is never sent to a model.
   */
  schema?: unknown;
  /** Monotonic version for this (toolCallId, namespace); Pi sets/increments it. */
  revision: number;
  /** Write time (ms epoch); Pi sets it. */
  updatedAt: number;
}

export interface AppendToolAnnotationInput<TData = unknown> {
  namespace: string;
  phase: ToolAnnotation["phase"];
  data: TData;
  schema?: unknown;
}
```

`ExtensionContext` (and the equivalent `ExtensionContextActions`) gains:

```ts
interface ExtensionContext {
  /**
   * Attach or update an annotation for a tool call.
   *
   * - Coalesces by (toolCallId, namespace): a later call with phase "streaming"
   *   or "final" replaces the prior data and bumps `revision`. This is the one
   *   sanctioned in-place update; it does NOT mutate any session entry.
   * - Never enters LLM context. Never triggers an agent turn. No steer/followUp.
   * - Persisted with the session so it survives resume/fork/tree navigation.
   * - Triggers a TUI repaint of just the owning tool row (see invalidation).
   *
   * Safe to call from tool_execution_start/_update/_end without awaiting a model
   * inside a blocking hook (the writer streams into it asynchronously).
   */
  appendToolAnnotation<TData = unknown>(
    toolCallId: string,
    input: AppendToolAnnotationInput<TData>,
  ): void;

  /** Read current annotations for a tool call (all namespaces). */
  getToolAnnotations(toolCallId: string): ReadonlyMap<string, ToolAnnotation>;
}
```

Persistence: add a `tool_annotation` session record type written via the existing
JSONL append path. On load, Pi folds records by `(toolCallId, namespace)` keeping
the highest `revision`, rebuilding the live map. Because it is keyed by
`toolCallId` (stable across call/result renders, per `ToolRenderContext.toolCallId`)
it reattaches to the right row after resume/fork without any extension bookkeeping.

Why a new record type and not `appendCustomEntry`: `custom` entries already exist
and already stay out of context (constraint 7), but they are opaque blobs not
keyed to a tool call, carry no coalescing/revision semantics, and do not drive
row invalidation. `tool_annotation` is the minimal typed channel that does.

### 2. Render context exposes annotations + a view mode

Extend the existing interfaces with optional fields (no breaking change):

```ts
export type ToolViewMode = "raw" | "lens";

export interface ToolRenderContext<TState = any, TArgs = any> {
  // ...all existing fields unchanged (args, toolCallId, expanded, ...)
  /** Annotations for this tool call, keyed by namespace. Empty map if none. */
  annotations: ReadonlyMap<string, ToolAnnotation>;
  /** Current per-row view mode. "raw" unless the user toggled to "lens". */
  viewMode: ToolViewMode;
}

export interface ToolRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
  /** Mirror of ToolRenderContext.viewMode for renderers that read options. */
  viewMode: ToolViewMode;
}
```

A renderer opts in by reading the new fields; renderers that ignore them are
unaffected:

```ts
renderResult(result, options, theme, context) {
  const lens = context.annotations.get("tool-lens");
  if (context.viewMode === "lens" && lens) return renderLens(lens, theme);
  return renderRaw(result, options, theme); // unchanged default
}
```

`viewMode` defaults to `"raw"`. A row only has a meaningful lens view if some
namespace published an annotation for it; otherwise the toggle is a no-op for
that row (see TUI below).

### 3. Built-in / provider-profile opt-in without re-registration

The opt-in is "read `context.annotations` in your existing `renderResult`",
which the built-ins can adopt directly. For tools an extension does **not** own
(so it cannot edit their `renderResult`), add a non-owning lens renderer registry
keyed by namespace, consulted by `ToolExecutionComponent` only when
`viewMode === "lens"`:

```ts
interface ExtensionContext {
  /**
   * Register a lens renderer that draws the "lens" view for ANY tool row when an
   * annotation for `namespace` exists and the row is in lens mode. Does NOT
   * replace the tool, its execute, or its raw renderer. The raw view is always
   * the tool's own renderResult. Last registration per namespace wins.
   */
  registerToolLensRenderer(
    namespace: string,
    renderer: (
      annotation: ToolAnnotation,
      result: AgentToolResult<unknown>,
      theme: Theme,
      context: ToolRenderContext,
    ) => Component,
  ): void;
}
```

Resolution in `ToolExecutionComponent.getResultRenderer()` becomes:

```
viewMode === "lens" && lensRenderer(namespace) && annotations.has(namespace)
  -> lensRenderer            // draws the lens view, any tool, no co-ownership
otherwise
  -> toolDefinition.renderResult ?? builtInToolDefinition.renderResult  // unchanged
```

This is the key unlock vs constraints 1-2: lens rendering no longer requires
owning the tool name, so `tool-lens` can light up `shell_command`, `apply_patch`,
`read_file`, etc. without colliding with `provider-tool-profiles`.

### 4. TUI per-row raw/lens toggle (distinct from expand/collapse)

- New per-row action `toggleToolViewMode` flips the focused row's `viewMode`
  between `raw`/`lens`, calls `context.invalidate()` for that row only, and
  repaints. It is a separate keybinding from expand/collapse (which stays
  `ctrl+o` / `setToolsExpanded`, `dist/core/extensions/types.d.ts`
  `setToolsExpanded`).
- Suggested default `ctrl+r` (rebindable via the keybindings manager; extensions
  may also expose `pi.registerShortcut(...)`, verified signature in
  `core/extensions/types.d.ts` `registerShortcut`). Final default to be picked by
  Pi to avoid collisions.
- Rows with no annotation for any active lens namespace render the toggle inert
  (no flicker, optional dim hint), so the axis is harmless on normal tool rows.
- Optional global default `viewMode` and an "apply to all rows" variant mirroring
  `setToolsExpanded`, behind a follow-up if scope creep is a concern.

### 5. Optional: zero-height custom row (stretch)

`CustomMessageComponent` unconditionally `addChild(new Spacer(1))` in its
constructor (`dist/modes/interactive/components/custom-message.js`), so a hidden
card cannot be truly zero-height (constraint 8). Add an opt-in
`display: "compact"` / `hidden` flag on the custom-message render path that skips
the leading spacer, enabling a genuinely hidden row. This is independent of the
annotation work and can ship separately; `tool-lens` uses a one-line stub until
it lands.

## Mapping to issue #12 acceptance criteria

- [x] Persist annotations keyed by `toolCallId` without LLM context ->
  `appendToolAnnotation` + `tool_annotation` record (API 1). Never converted to an
  `AgentMessage`, so it bypasses `context`/`convertToLlm` entirely.
- [x] Tool render context exposes annotations -> `ToolRenderContext.annotations`
  (API 2).
- [x] Stream/update while running, no extra LLM turn -> coalescing
  `appendToolAnnotation` called from `tool_execution_start/_update/_end`; no
  steer/followUp, so no `streamAssistantResponse` re-entry (constraint 6 avoided
  by construction).
- [x] Per-tool raw/lens toggle distinct from expand/collapse -> API 4
  (`toggleToolViewMode`, separate keybinding from `setToolsExpanded`).
- [x] Built-in and provider-profile renderers opt in without re-registering ->
  read `context.annotations` directly, or `registerToolLensRenderer` for
  non-owned tools (API 3).
- [x] Survive resume/fork/tree navigation -> persisted `tool_annotation` records
  folded by `(toolCallId, namespace)` on load, reattached by stable `toolCallId`.

## Implementation plan (upstream Pi)

1. **Types + record.** Add `ToolAnnotation`, `AppendToolAnnotationInput`,
   `ToolViewMode`; add the `tool_annotation` session record and its JSONL
   (de)serialization in `session-manager`. Pure additive types; no behavior yet.
2. **Store + context methods.** Implement `appendToolAnnotation` /
   `getToolAnnotations` on `ExtensionContext` and the runtime store (coalesce by
   `(toolCallId, namespace)`, bump `revision`, set `updatedAt`). Load-time fold.
3. **Render context wiring.** Populate `ToolRenderContext.annotations` and
   `viewMode`, and `ToolRenderResultOptions.viewMode`, from the store in
   `ToolExecutionComponent`. Default `viewMode = "raw"`.
4. **Invalidation.** On `appendToolAnnotation`, invalidate only the owning row
   (reuse the per-row `invalidate()` already on `ToolRenderContext`). No global
   repaint.
5. **Lens renderer registry.** Add `registerToolLensRenderer` and the
   lens-first branch in `getResultRenderer()`, gated on
   `viewMode === "lens" && annotations.has(namespace)`.
6. **TUI toggle.** Add `toggleToolViewMode` + keybinding, focused-row only,
   distinct from expand. Inert on rows without a lens annotation.
7. **(Optional) zero-height card flag** in the custom-message path.
8. **Docs + CHANGELOG.** Document the channel's context/turn guarantees and the
   new keybinding.

Each step is independently testable and shippable; 1-4 deliver persistence +
context exposure, 5-6 deliver the visible toggle.

## Test plan (upstream Pi)

Unit:
- `appendToolAnnotation` coalesces by `(toolCallId, namespace)`, bumps `revision`,
  preserves other namespaces.
- Annotations never appear in `context`/`convertToLlm` output (assert an LLM
  message snapshot is byte-identical with and without annotations).
- **No extra turn**: an SDK harness (`createAgentSession` + a fake model counting
  provider calls) runs one tool, streams several `appendToolAnnotation` calls
  during execution, and asserts the provider-call count is unchanged. This is the
  same delivery/cost gate #11 relies on, now proven structurally.
- Persistence round-trip: write annotations, reload session, fold restores latest
  `revision` per key; reattaches by `toolCallId` after a fork.
- `getResultRenderer()`: lens branch only taken when `viewMode === "lens"` and an
  annotation exists for an active namespace; otherwise the existing raw renderer.
- `ToolRenderContext.viewMode` defaults to `"raw"`; `toggleToolViewMode` flips
  only the focused row and calls `invalidate` once.

Interactive/snapshot:
- A row in `raw` renders the tool's own output; toggled to `lens` renders the
  registered lens renderer; toggled back is identical to the original raw frame.
- Toggle on a no-annotation row is inert (no frame change beyond an optional hint).
- Expand/collapse and raw/lens are independent (4 combinations render correctly).

Parallel (constraint 10):
- Annotations written per `toolCallId` across an interleaved batch attach to the
  correct rows; display stays source-ordered; completion-order writes do not
  scramble rows.

## Risks and open questions

- **Storage growth.** Streaming writes coalesce in memory but each persisted
  revision is a JSONL line. Mitigation: persist only `final`/`error` phases by
  default and treat `streaming` as in-memory-only (configurable), or compact
  superseded revisions at session save. Decision needed before step 2.
- **Keybinding collision.** `ctrl+r` is a suggestion; Pi owns the final default.
  The toggle must degrade to inert on rows without a lens annotation so it is
  never surprising.
- **Lens registry precedence.** "Last registration per namespace wins" mirrors
  tool registration. Multiple lens namespaces on one row need a selection rule
  (active namespace from config, or cycle); v1 can assume a single active lens
  namespace and defer multi-lens cycling.
- **`schema` semantics.** Kept opaque to Pi in v1 (writer's contract). If Pi ever
  validates it, that is a separate enhancement; do not block #12 on it.
- **Export/HTML parity.** The HTML exporter renders tools via its own
  `tool-renderer` (`dist/core/export-html/tool-renderer.js`, `renderResult(...)`).
  Lens views in exported transcripts are out of scope for v1; note it so export
  stays raw-only initially.
- **Version drift.** Verified against `0.73.1`; the github-issue drafts in this
  repo mention Pi `0.79.0`. Re-verify the cite map against the target Pi version
  before implementing upstream.

## Relationship

- Unblocks the target UX of #11 (`tool-lens`): true inline streaming under each
  tool row + a real raw/lens swap, replacing the hybrid HUD + idle-card
  compromise. Until #12 lands, `tool-lens` ships the hybrid (per `ideas/tool-analyzer-extension.md`).
- Sibling design doc: `ideas/tool-analyzer-extension.md` (PR #13).
- This doc is the core-side contract; the extension-side consumer is #11.
