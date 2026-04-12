client<llm> PromptRenderer {
  provider openai-generic
  options {
    base_url "http://localhost:11434/v1"
    model "gemma4:e4b"
    default_role "user"
  }
}
