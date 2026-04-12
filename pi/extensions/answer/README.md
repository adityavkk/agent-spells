# answer

Interactive answer flow for agent-generated questions.

## Files

- `index.ts` - extension entrypoint
- `extraction.ts` - structured extraction bridge
- `core.ts` - normalized types and answer formatting
- `ui.ts` - interactive terminal UI
- `debug.ts` - gated debug logging
- `*.test.ts` - unit/integration coverage

## Test coverage

- core normalization and transcript formatting
- extraction bridge request/parse behavior
- live integration against local Ollama when available
