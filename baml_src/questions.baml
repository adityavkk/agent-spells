enum QuestionType {
  TEXT
  SINGLE_CHOICE
  MULTIPLE_CHOICE
}

class Option {
  label string
  value string?
  description string?
}

class Question {
  question string
  context string?
  type QuestionType
  options Option[]
  allowOther bool
  otherLabel string?
}

class ExtractionResult {
  questions Question[]
}

function ExtractQuestions(input: string) -> ExtractionResult {
  client PromptRenderer
  prompt #"
    You are a questionnaire extractor. Given text from a conversation, extract every question that needs user input and return structured data.

    Rules:
    - Extract all questions that require user input
    - Keep questions in the order they appeared
    - Use type TEXT for open-ended questions or whenever options are unclear
    - Use type SINGLE_CHOICE only when exactly one option should be chosen
    - Use type MULTIPLE_CHOICE only when multiple selections are allowed, for example select all that apply
    - For choice questions, include options only when they are explicit or strongly implied by the text
    - Never invent options that are not present in the source text
    - If options are ambiguous, fall back to type TEXT
    - Set allowOther to true only when a free-form answer should be allowed in addition to the listed options
    - Omit or leave options empty for TEXT questions
    - Keep question and option labels concise
    - If no questions are found, return an empty questions list

    Input:
    {{ input }}

    {{ ctx.output_format }}
  "#
}
