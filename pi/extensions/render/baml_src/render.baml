enum BlockType {
  MARKDOWN
  LIST
  QUESTIONNAIRE
  COLLECTION
}

enum PreferredView {
  AUTO
  STACK
  TABS
}

enum EmbeddedContentType {
  MARKDOWN
  LIST
  QUESTIONNAIRE
}

enum QuestionType {
  TEXT
  SINGLE_CHOICE
  MULTIPLE_CHOICE
  RANKING
}

class QuestionOption {
  id string?
  label string
  value string?
  description string?
}

class QuestionConstraints {
  minSelections int?
  maxSelections int?
  minSentences int?
  maxSentences int?
}

class Question {
  id string?
  type QuestionType
  question string
  context string?
  options QuestionOption[]
  allowOther bool
  otherLabel string?
  answerInstructions string?
  constraints QuestionConstraints?
}

class ListItem {
  id string?
  navLabel string?
  title string?
  summary string?
  bodyMarkdown string
}

class EmbeddedContent {
  type EmbeddedContentType
  markdown string?
  ordered bool?
  items ListItem[]
  questions Question[]
}

class CollectionItem {
  id string?
  navLabel string?
  title string?
  summary string?
  content EmbeddedContent
}

class Block {
  id string?
  type BlockType
  title string?
  preferredView PreferredView?
  ordered bool?
  markdown string?
  items ListItem[]
  questions Question[]
  collectionItems CollectionItem[]
}

class RenderDoc {
  title string?
  introMarkdown string?
  blocks Block[]
}

function ExtractRenderDoc(input: string) -> RenderDoc {
  client PromptRenderer
  prompt #"
    You are a structured renderer extractor.

    Convert the input into a semantic render document.

    Rules:
    - Return a RenderDoc with one or more blocks
    - Preserve source order
    - Use MARKDOWN for plain prose sections
    - Use LIST for enumerated or itemized sections
    - Use QUESTIONNAIRE for questions that need user input
    - Use COLLECTION for grouped sections where each item has its own content
    - Field discipline matters:
      - MARKDOWN blocks: put prose in markdown; leave items, questions, collectionItems empty
      - LIST blocks: put entries in items; leave questions, collectionItems empty
      - QUESTIONNAIRE blocks: put prompts in questions; leave items, collectionItems empty
      - COLLECTION blocks: put grouped entries in collectionItems; leave items, questions empty
      - EmbeddedContent MARKDOWN: use markdown only
      - EmbeddedContent LIST: use items only
      - EmbeddedContent QUESTIONNAIRE: use questions only
    - Do not put collection-style entries into items
    - Do not put list entries into collectionItems
    - preferredView is only a hint; set it only when strongly implied
    - Never invent facts
    - Keep navLabel short when present
    - For unused block fields, use empty arrays and omit nullable text when possible
    - If no structure is apparent, return one MARKDOWN block

    Input:
    {{ input }}

    {{ ctx.output_format }}
  "#
}
