enum QuestionType {
  TEXT
  SINGLE_CHOICE
  MULTIPLE_CHOICE
  RANKING
}

class Option {
  label string
  value string?
  description string?
}

class AnswerConstraints {
  minSelections int?
  maxSelections int?
  minSentences int?
  maxSentences int?
}

class Question {
  question string
  context string?
  type QuestionType
  options Option[]
  allowOther bool
  otherLabel string?
  answerInstructions string?
  constraints AnswerConstraints?
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
    - Use type RANKING when the user must rank or order the listed options
    - For choice and ranking questions, include options only when they are explicit or strongly implied by the text
    - Never invent options that are not present in the source text
    - If options are ambiguous, fall back to type TEXT
    - Set allowOther to true only when a free-form answer should be allowed in addition to the listed options
    - Omit or leave options empty for TEXT questions
    - Capture explicit answer constraints declaratively in constraints, such as choose up to N items or write 1-3 sentences
    - Use answerInstructions only for concise guidance that is explicit in the source text and not already represented by type, options, allowOther, or constraints
    - Do not invent constraints or answerInstructions
    - Keep question and option labels concise
    - If no questions are found, return an empty questions list

    Input:
    {{ input }}

    {{ ctx.output_format }}
  "#
}
