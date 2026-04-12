# agent-spells

Personal repo for agent-facing helpers, structured workflows, and small automations.

Not a framework. Just the stuff I use and iterate on.

## Current contents

- interactive answer workflow under `pi/extensions/answer/`
- shared structured-extraction definitions under `baml_src/`
- generated client code under `baml_client/`

## Repo shape

- `pi/extensions/answer/`
  - interactive answer flow
  - extraction bridge
  - normalization logic
  - tests
- `baml_src/`
  - source schemas/prompts for structured extraction
- `baml_client/`
  - generated TypeScript client checked in for stable local/runtime use

## Install

```bash
bun install
```

## Common commands

Regenerate generated client code:

```bash
bun run baml-generate
```

Run test suite:

```bash
bun run test
```

Run only the live integration test:

```bash
bun run test:integration
```

If local Ollama is available on `http://127.0.0.1:11434`, the live integration test runs automatically as part of `bun run test`. Otherwise it skips.

## Notes

This repo can be consumed from my local agent setup directly. For example, the current home-manager config links the answer workflow from:

- `~/dev/agent-spells/pi/extensions/answer/index.ts`
