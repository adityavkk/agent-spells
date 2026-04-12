# agent-spells

A small grimoire for the way I like to enchant my agent.

Not a framework. Not a platform. Just spells: sharp little workflows, structured prompts, BAML schemas, and terminal rituals that make the agent a bit more useful, a bit less annoying, and occasionally almost civilized.

## What lives here

- `pi/extensions/answer/`
  - interactive answer flow for agent-generated questions
  - free-form, single-choice, multiple-choice, and ranking support
  - declarative constraints carried through extraction and UI
  - tests for normalization, extraction, and live integration
- `baml_src/`
  - source BAML types and prompts for structured extraction
- `baml_client/`
  - generated TypeScript client checked in for stable local/runtime use

## Philosophy

I like my agent the same way I like my tools:
- composable
- inspectable
- easy to swap out
- slightly magical
- never more complicated than necessary

So this repo is where I keep the enchantments.

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

This repo is consumed directly from my local agent setup. Example:

- `~/dev/agent-spells/pi/extensions/answer/index.ts`
