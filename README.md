# agent-spells

Coding agent extensions, general spells, and small workflows I use to make the machine more useful.

Not a framework. Just a spellbook.

## What lives here

- `pi/extensions/answer/`
  - interactive answer flow for agent-generated questions
  - free-form, single-choice, multiple-choice, and ranking support
  - tests for normalization, extraction, and live integration

More spells over time.

## Philosophy

I like my agent tooling:
- composable
- inspectable
- easy to tweak
- useful fast
- no more elaborate than it needs to be

This repo is where I keep those enchantments.

## Install

```bash
bun install
```

## Common commands

Generate local client code:

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
