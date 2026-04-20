# render grammar v1

Keep grammar semantic. Shallow. Layout-agnostic.

## Design rules

- content grammar, not TUI grammar
- surfaces choose layout
- tabs/select-list/stack = render hints, not truth
- no deep recursive AST in v1
- runtime state separate from extracted content
- fallback always possible to one markdown block

## Top-level shape

```ts
type RenderDoc = {
  version: "v1";
  title?: string;
  introMarkdown?: string;
  blocks: Block[];
};

type Block =
  | MarkdownBlock
  | ListBlock
  | QuestionnaireBlock
  | CollectionBlock;
```

## Blocks

```ts
type MarkdownBlock = {
  id: string;
  type: "markdown";
  markdown: string;
};

type ListBlock = {
  id: string;
  type: "list";
  title?: string;
  preferredView?: "auto" | "stack" | "tabs";
  ordered?: boolean;
  items: ListItem[];
};

type ListItem = {
  id: string;
  navLabel?: string;    // short; tabs, picker, nav rail
  title?: string;       // full heading
  summary?: string;     // collapsed preview
  bodyMarkdown: string; // detail body
};

type QuestionnaireBlock = {
  id: string;
  type: "questionnaire";
  title?: string;
  questions: Question[];
};

type CollectionBlock = {
  id: string;
  type: "collection";
  title?: string;
  preferredView?: "auto" | "stack" | "tabs";
  items: CollectionItem[];
};

type CollectionItem = {
  id: string;
  navLabel?: string;
  title?: string;
  summary?: string;
  content: SimpleContent;
};

type SimpleContent =
  | { type: "markdown"; markdown: string }
  | { type: "list"; ordered?: boolean; items: ListItem[] }
  | { type: "questionnaire"; questions: Question[] };
```

## Questions

Re-use `answer` semantics.

```ts
type Question =
  | {
      id: string;
      type: "text";
      question: string;
      context?: string;
      answerInstructions?: string;
      constraints?: {
        minSentences?: number;
        maxSentences?: number;
      };
    }
  | {
      id: string;
      type: "single_choice" | "multiple_choice" | "ranking";
      question: string;
      context?: string;
      options: Array<{
        id: string;
        label: string;
        value?: string;
        description?: string;
      }>;
      allowOther?: boolean;
      otherLabel?: string;
      answerInstructions?: string;
      constraints?: {
        minSelections?: number;
        maxSelections?: number;
      };
    };
```

## Surface contract

Each surface should accept:

```ts
type RenderSurface<Input, Output> = {
  name: string;
  render(doc: RenderDoc, runtime: RenderRuntime, options?: Input): Promise<Output> | Output;
};
```

Examples:
- TUI surface -> interactive component tree
- HTML surface -> html string/file
- Markdown surface -> markdown string/file

## Runtime contract

```ts
type RenderRuntime = {
  renderSessionId: string;
  sourceEntryId: string;     // assistant entry being rendered
  revision: number;
  selections: Record<string, unknown>;
  answers: Record<string, unknown>;
  edits: Record<string, unknown>;
  branch?: {
    mode: "none" | "tree-revision";
    sessionFile?: string;
    leafEntryId?: string;
  };
};
```

Runtime owns mutable state. `RenderDoc` stays semantic.

## Normalization rules

Must enforce:
- stable IDs everywhere
- trim/clean placeholder text
- cap `navLabel` to short length
- downgrade `preferredView: tabs` when item count too high
- empty or invalid extraction -> markdown fallback
- no empty list/questionnaire blocks

## Tree-backed mutation semantics

Treat rendered edits as transformations of assistant output, not direct history mutation.

Conceptually:
- render assistant entry `sourceEntryId`
- user edits projection through some surface
- runtime materializes edited assistant content
- extension creates/follows branch
- new assistant message on that branch becomes latest revision

This keeps:
- original conversation immutable
- edits inspectable
- multiple alternative rewrites possible
- rendering surfaces swappable

## Rendering heuristics

Surface may ignore `preferredView`.

Examples:
- TUI list, 2-7 items -> tabs likely good
- TUI list, 8+ items -> picker + detail pane
- Markdown -> headings + bullets
- HTML -> tabs, accordion, or cards

## Revision model

`RenderDoc` + runtime state produce revisions.

Revision actions:
- answer
- select
- edit
- regenerate
- export
- branch

Branch semantics:
- edits are immutable
- editing does not overwrite old assistant content
- instead, create a new assistant revision on a tree branch
- branch is conceptually similar to `/tree`
- rendered surfaces should treat latest branch revision as current view

Persist by `renderSessionId`.
Do not rely on rendered output as canonical state.
