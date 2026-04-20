# render

General structured-render extension. Successor path for `answer`.

Goal:
- one orchestration path
- one semantic render grammar
- many rendering surfaces
- same extracted payload can render as TUI, HTML, Markdown, later others
- same rendered artifact can support responses, selections, and edits
- edits are immutable: branch conversation/tree, produce new assistant revision

## Core stance

Do not make the LLM emit terminal layout.

Instead:
- BAML defines the semantic content grammar and generates TS content types
- LLM emits semantic `RenderDoc`
- runtime normalizes that parsed doc
- surface adapter chooses final layout
- runtime state tracks cursor/tab/answers/edits separately

Why:
- TUI layout depends on terminal width/height
- tabs good for some lists, bad for many
- HTML/Markdown/TUI need different layout decisions
- semantic payload easier to test than a giant TUI AST

## Pipeline

```text
source text/message
  -> extractor model
  -> RenderDoc
  -> normalize/repair
  -> interaction state + actions
  -> surface adapter
  -> rendered artifact
  -> optional branch/edit action
  -> new assistant revision on conversation tree
```

## Main pieces

Current:

1. `index.ts`
   - live pi extension entrypoint
   - `/render`
   - `/render reopen`
   - extractor orchestration
   - persisted render-session messages

2. `extract.ts`
   - second-model extraction
   - BAML prompt/schema
   - parse + fallback

3. `normalize.ts`
   - repair parsed BAML output
   - IDs
   - defaults
   - validation

4. `core.ts`
   - runtime/session/revision/action/surface types

5. `session.ts`
   - create/read persisted render sessions
   - update current runtime selections

6. `ui.ts`
   - minimal TUI viewer
   - custom message rendering

Planned next:
- richer surface adapters
- revision/edit actions
- branch-backed mutation flow
- HTML/Markdown exporters

## Message model

Render output should not be the source of truth.

Source of truth:
- normalized BAML-generated `RenderDoc`
- user interaction state
- revision history

Rendered views are projections of that state.

## Mutation model

Desired UX: edit rendered content and have the assistant message feel updated.

Better model: immutable mutation.

Meaning:
- user edits rendered projection
- runtime computes a transformed assistant message
- extension branches conversation state, like `/tree`
- new branch gets a new assistant revision representing the edited content
- original message remains intact in history

So v1 should model updates as revisions on a render session:
- stable `renderSessionId`
- stable `sourceEntryId` for the assistant message being rendered
- each edit creates a new `revision`
- optionally create a tree branch anchored at `sourceEntryId`
- branch contains a new assistant message/details representing edited output
- surfaces reopen latest revision for that branch/session

If pi later exposes true historical message replacement, swap implementation behind runtime layer. Semantic grammar stays the same.

## Current live behavior

Today:
- `/render` extracts the last assistant message into a normalized `RenderDoc`
- opens a minimal TUI viewer
- persists a `render-session` custom message with canonical session details
- `/render reopen` reopens the latest persisted render session on the current branch

Not done yet:
- editing
- branching new assistant revisions
- questionnaire answer capture
- HTML/Markdown export surfaces
- full multi-surface runtime abstraction

## Scope for v1

Support these semantic blocks:
- markdown
- list
- questionnaire
- collection

Render surfaces:
- TUI first
- HTML exporter next
- Markdown exporter next

Actions:
- answer questions
- navigate list items
- capture selections
- edit generated content into a new revision
- branch edited assistant revisions onto conversation tree

## Relationship to `answer`

`answer` becomes one specialized block + TUI workflow inside this system.
Not separate orchestration forever.
