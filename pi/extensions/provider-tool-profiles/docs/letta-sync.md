# Letta tool sync strategy

Goal: keep `provider-tool-profiles` close to Letta Code without letting upstream churn silently change Pi capabilities.

Assumption: "LEDA/Ledda" means Letta Code upstream: <https://github.com/letta-ai/letta-code>.

## Current state

The extension has three separate concerns that are easy to conflate:

1. Vendored upstream schemas and descriptions.
   - Source: `vendor/letta/schemas/*.json`, `vendor/letta/descriptions/*.md`
   - Refresh script: `scripts/update-from-letta.ts`
   - Metadata: `vendor/letta/SOURCE.md`
2. Local Pi wrapper implementations.
   - Claude: `tools/claude.ts`
   - Codex: `tools/codex.ts`
   - Gemini: `tools/gemini.ts`
3. Activation policy.
   - Current profile lists: `types.ts`
   - Runtime switching: `tool-activation.ts`

Recent sync work did the safe first slice for issue #6:

- Updated the Letta pin to `2eca6e1354e37413e5b0840243ac208b8add7bd5`.
- Refreshed changed vendored files:
  - `Bash`
  - `RunShellCommandGemini`
  - `ShellCommand`
  - `UpdatePlan`
  - `ViewImage`
- Added newer Codex schemas/descriptions to the vendor snapshot, but did not activate them:
  - `ExecCommand` / model-facing `exec_command`
  - `WriteStdin` / model-facing `write_stdin`
  - `Shell` / model-facing `shell`
  - `ReadFileCodex` / model-facing `read_file` or `ReadFile`
  - `ListDirCodex` / model-facing `list_dir` or `ListDir`
- Confirmed latest Letta OpenAI default direction now prefers `exec_command` + `write_stdin` over `shell_command`.
- Kept Pi activation on the compatibility Codex surface: `shell_command`, `apply_patch`, `update_plan`, `view_image`.

That was correct. `exec_command` and `write_stdin` are not just schema changes. They imply a local process/session manager, stdin writes, polling, cancellation, cleanup, and maybe PTY behavior. Those semantics need design before activation.

## Pain in the current workflow

Manual steps today:

1. Find latest Letta ref.
2. Clone/fetch upstream.
3. Diff vendored selected files.
4. List upstream tool files that are not vendored.
5. Inspect `src/tools/manager.ts` and `src/tools/tool-definitions.ts` for default toolset changes.
6. Decide what to vendor, export, test, document, and activate.
7. Run tests.
8. Summarize upstream behavior manually.

Problems:

- Tool selection is duplicated across code, script, tests, docs, and human memory.
- The refresh script copies files but does not explain drift.
- New upstream tools are invisible unless someone compares all upstream schema names.
- Upstream default toolset changes require reading Letta implementation code by hand.
- Activation policy can accidentally lag or overreact to vendored schema changes.
- No CI guard says "Letta changed; review needed."

## Current streamlined baseline

The first automation slice now exists:

- `vendor/letta/tool-manifest.json` classifies each known upstream tool as `active`, `vendored`, `blocked`, or `ignored`.
- `vendor/letta/default-toolsets.json` snapshots Letta's extracted default toolsets.
- `scripts/update-from-letta.ts` reads the manifest instead of a hard-coded file list.
- `scripts/check-letta-drift.ts` writes a read-only drift report to `.tmp/letta-drift/`.
- `.github/workflows/letta-drift.yml` runs the drift check weekly and opens or updates a GitHub issue when drift appears.

Use it like this:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main
cat .tmp/letta-drift/summary.md
cat .tmp/letta-drift/recommended-actions.md
```

When intentionally updating the default toolset snapshot after review:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref <sha> --update-toolset-snapshot
```

## Design principle

Keep a hard boundary:

```text
upstream snapshot != local implementation != active capability
```

Vendoring should be cheap and frequent. Activation should be deliberate and capability-aware.

## Complementary Pi compatibility check

Letta drift is only one side of the hybrid contract. We also need a Pi compatibility workflow so provider-tool-profiles keeps using Pi's public runtime APIs correctly while Pi evolves.

Two upstream axes must stay separate:

```text
Letta compatibility = model-facing schemas/descriptions/default toolsets
Pi compatibility = runtime primitives, public exports, tool result shapes, TUI contracts
```

A Letta sync is not safe to activate until Pi compatibility is green for the affected capability. Example: Letta may move Codex defaults to `exec_command` + `write_stdin`, but Pi compatibility remains blocked until Pi has explicit process-session, stdin, polling, timeout, abort, and cleanup semantics for that capability.

### GitHub workflow: `pi-compat`

A sibling workflow now exists at `.github/workflows/pi-compat.yml`.

Triggers:

- `pull_request` touching `pi/extensions/provider-tool-profiles/**`, `package.json`, `bun.lock`, or the workflow itself.
- `workflow_dispatch` with optional `pi_ref` / `pi_version` input.
- Weekly schedule, offset from Letta drift.

Jobs:

1. **Locked Pi check, blocking on PRs**
   - `bun install --frozen-lockfile`
   - `bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts`
   - `bun pi/extensions/provider-tool-profiles/scripts/check-pi-compat.ts --mode locked`
   - static import check: provider-tool-profiles must import Pi packages only through `tools/pi-compat.ts` and must not import Pi `dist/**`, `core/**`, `src/**`, or mode internals.
2. **Latest Pi canary, issue-only on schedule/dispatch**
   - install the requested/latest published Pi packages in a temp directory, without mutating this repo's lockfile.
   - assert required public exports exist:
     - `withFileMutationQueue`
     - `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`
     - `createLocalBashOperations`
     - `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`, `createLsToolDefinition`, `createGrepToolDefinition`, `createFindToolDefinition`
   - create native tool definitions against a temp cwd and run minimal read/write/bash smoke calls where safe.
   - write `.tmp/pi-compat/*` reports.
   - on scheduled/dispatch canary failure, open/update one issue: `provider-tool-profiles: Pi compatibility drift` with label `area:provider-tool-profiles,pi-compat,needs-design`.

PR behavior:

- Fail PRs for locked-package test failures, private Pi imports, schema export breakage, or TUI renderer width/control-sequence regressions.
- Do not fail ordinary PRs solely because latest Pi changed after the repo lockfile. Scheduled canary should open an issue instead.

### Script: `check-pi-compat.ts`

Output files mirror the Letta drift script:

- `.tmp/pi-compat/summary.md`
- `.tmp/pi-compat/public-api.json`
- `.tmp/pi-compat/private-imports.txt`
- `.tmp/pi-compat/native-tool-smoke.json`
- `.tmp/pi-compat/recommended-actions.md`

The report should answer:

- Are all Pi public exports used by provider-tool-profiles still present?
- Did any local file import private Pi internals?
- Do native read/write/bash/list/search tool factories still instantiate?
- Do result details still have the fields our adapters expect, such as truncation metadata and `fullOutputPath`?
- Are TUI renderers still width-safe with current Pi TUI utilities?
- Which provider capability is affected: read, write, edit, bash, glob/find, grep, list, image, plan, patch?

### Compatibility decision rule

For every Letta drift item, ask both questions before activation:

1. Does the Letta/provider contract require a schema or default-toolset change?
2. Does Pi expose a public runtime primitive that safely implements the required capability?

If yes to 1 and no to 2, vendor only and mark `blocked` in `vendor/letta/tool-manifest.json`.

## Proposed future architecture

### 1. Replace hard-coded `FILES` with a tool manifest

Add `vendor/letta/tool-manifest.json` as the single source of truth:

```json
{
  "upstream": "https://github.com/letta-ai/letta-code",
  "ref": "2eca6e1354e37413e5b0840243ac208b8add7bd5",
  "tools": [
    {
      "upstreamName": "ExecCommand",
      "provider": "codex",
      "modelNames": ["exec_command"],
      "status": "vendored",
      "activation": "blocked",
      "blockedBy": "needs local exec session manager",
      "capabilities": ["bash"],
      "files": ["schemas/ExecCommand.json", "descriptions/ExecCommand.md"]
    }
  ]
}
```

Script outputs and tests derive from this manifest. No more updating five places for one new schema.

Useful status values:

- `active`: registered and activated by policy.
- `registered`: implementation exists, not activated by default.
- `vendored`: copied for tracking only.
- `ignored`: intentionally out of scope.
- `blocked`: useful upstream change, but missing local semantics.

### 2. Add `check-letta-drift.ts`

New command:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main
```

Output files:

- `.tmp/letta-drift/summary.md`
- `.tmp/letta-drift/changed-vendored-files.patch`
- `.tmp/letta-drift/new-upstream-tools.json`
- `.tmp/letta-drift/default-toolsets.json`
- `.tmp/letta-drift/recommended-actions.md`

It should answer:

- Which vendored files changed?
- Which upstream tool schema/description files are new, deleted, or renamed?
- Which upstream default toolsets changed?
- Which changed tools are currently active in Pi?
- Which changes are schema-only vs behavior-affecting?
- Which local tests need attention?

The script should be read-only by default. Add `--apply` for copying vendored files.

### 3. Parse upstream default toolsets mechanically

Stop hand-reading `src/tools/manager.ts` each time.

The drift script can use a lightweight parser/regex for exported arrays:

- `ANTHROPIC_DEFAULT_TOOLS`
- `OPENAI_DEFAULT_TOOLS`
- `GEMINI_DEFAULT_TOOLS`
- `OPENAI_PASCAL_TOOLS`
- `GEMINI_PASCAL_TOOLS`

Store last extracted values in:

```text
vendor/letta/default-toolsets.json
```

Then diff them on every sync. Example report:

```text
OpenAI default changed:
- removed: shell_command
- added: exec_command, write_stdin
- unchanged: apply_patch, update_plan, view_image

Risk: behavior-affecting. Active Pi Codex profile still uses shell_command.
Action: keep compatibility mode; track exec session manager design.
```

### 4. Generate schema exports and snapshot tests from the manifest

Current friction:

- Add files to sync script.
- Add exports to `tools/schemas.ts`.
- Add tests to `schema-snapshot.test.ts`.

Better:

- `tools/schemas.ts` imports by explicit helper, but exports can be generated into `tools/generated-schemas.ts`.
- Snapshot test loops over manifest tools and verifies each file exists, parses, and has expected `required` keys if declared.

Keep generated files small and readable. Do not generate runtime implementations.

### 5. Introduce a compatibility decision table

Add `docs/tool-compatibility.md` or embed in the manifest:

| Upstream tool | Local wrapper | Active? | Capability | Risk | Decision |
|---|---|---:|---|---|---|
| `ShellCommand` | `shell_command` | yes | `bash` | known compatibility | Keep until exec sessions exist |
| `ExecCommand` | none | no | `bash` | process/session semantics | Vendor only |
| `WriteStdin` | none | no | `bash` | stdin/polling/session lifecycle | Vendor only |
| `ReadFileCodex` | none | no | `read` | low | Consider read-only Codex wrapper |
| `ListDirCodex` | none | no | `ls` | low | Consider read-only Codex wrapper |

This turns sync from "what changed?" into "which decision changed?".

### 6. Add a scheduled drift bot

GitHub Action weekly or daily:

1. Run `check-letta-drift.ts --ref main`.
2. If no changes, exit clean.
3. If changes exist, open or update one issue: `provider-tool-profiles: Letta drift`.
4. Attach the generated summary.
5. Apply labels:
   - `area:provider-tool-profiles`
   - `needs-design` if default toolsets changed or active tools changed.
   - `documentation` if only descriptions changed.
   - `enhancement` if new non-active tools appeared.

Optional second mode: auto-open a PR for safe snapshot-only changes.

Safe auto-PR criteria:

- Only vendored schemas/descriptions changed.
- No upstream default toolset changed for active provider profiles.
- No schema `required` fields changed for active tools.
- Tests pass.

Everything else becomes an issue, not an auto-PR.

### 7. Categorize drift by blast radius

The drift report should classify each change:

#### A. Description-only

Usually safe. Auto-vendor if tests pass.

Examples from the last sync:

- `Bash.md` wording
- `ViewImage.md` wording

#### B. Schema additive

Likely safe for inactive tools, review active tools.

Examples:

- New optional fields.
- Added enum narrowing can be behavior-affecting even if the local wrapper accepts wider values.

#### C. Schema required-field change

High risk for active tools. Needs implementation and tests.

#### D. Upstream default toolset change

Design review. Do not auto-activate.

Example:

- Codex moving from `shell_command` to `exec_command` + `write_stdin`.

#### E. New provider-specific tools

Vendor and classify. Implement only if it helps capability-aware mapping.

Examples:

- `ReadFileCodex`, `ListDirCodex` could reduce Codex read-only reliance on `shell_command`.

### 8. Separate "upstream names" from "Pi capabilities"

Issue #8 is the foundation. Provider sync is safer once activation maps canonical capabilities to provider-native names.

Future shape:

```ts
const PROFILE_TOOL_CAPABILITIES = {
  codex: {
    bash: ["shell_command"],
    read: ["read_file"],
    ls: ["list_dir"],
    edit: ["apply_patch"],
    write: ["apply_patch"],
    update_plan: ["update_plan"],
    view_image: ["view_image"],
  },
};
```

Then a Letta sync can add `ReadFileCodex` without accidentally granting shell to read-only roles.

### 9. Add a "shadow registration" mode

For new upstream tools, support local registration without default activation:

- registered in Pi
- excluded from `CODEX_TOOLS`
- invokable only by forced config or smoke tests

Example config:

```json
{
  "experimentalTools": {
    "codex": ["read_file", "list_dir"]
  }
}
```

This lets us test new wrappers on real models without committing them as defaults.

### 10. Add a Pi compatibility workflow

Add `.github/workflows/pi-compat.yml` and `scripts/check-pi-compat.ts` after the adapter layer starts importing Pi runtime primitives directly.

The workflow is the Pi-side mirror of Letta drift:

```text
check locked Pi -> check no private imports -> smoke public Pi factories -> run provider tests -> canary latest Pi -> issue if drift
```

Keep this workflow capability-aware. A latest-Pi break in `createLocalBashOperations()` should point to bash adapters; a break in `withFileMutationQueue()` should point to mutating file adapters.

### 11. Keep local implementations intentionally boring

Do not port Letta runtime internals wholesale.

Preferred implementation rule:

- Use Letta schemas/descriptions for model compatibility.
- Use Pi primitives for execution, files, rendering, cancellation, and approvals.
- Build a small local adapter only when Pi lacks a primitive.

For `exec_command`/`write_stdin`, the missing primitive is a session manager. Design it once, probably outside `provider-tool-profiles`, then wrap it.

## Recommended commands after streamlining

Daily/weekly Letta check:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main
```

Daily/weekly Pi compatibility check once the script exists:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-pi-compat.ts --mode locked
bun pi/extensions/provider-tool-profiles/scripts/check-pi-compat.ts --mode latest --output .tmp/pi-compat
```

Safe vendor refresh:

```bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts --ref <sha> --from-manifest
bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts
```

Design-affecting refresh:

```bash
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref <sha> --report-only
# review generated recommended-actions.md
# update manifest decisions
# implement wrappers or leave vendored-only
bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts
```

## Phased implementation plan

### Phase 1: Better drift reporting, no runtime changes

- Done: add `tool-manifest.json`.
- Done: add read-only `check-letta-drift.ts`.
- Done: extract upstream toolsets into `vendor/letta/default-toolsets.json`.
- Done: make `update-from-letta.ts` read manifest instead of hard-coded `FILES`.
- Done: add CI job that fails only on script/test errors, not on upstream drift.

### Phase 2: Safe Letta automation

- Add scheduled GitHub Action.
- Auto-open drift issue.
- Auto-PR description-only snapshot refreshes.
- Generate schema export/test coverage from manifest.

### Phase 2b: Pi compatibility automation

- Done: add `tools/pi-compat.ts` as the provider-tool import boundary for public Pi APIs.
- Done: add `scripts/check-pi-compat.ts`.
- Done: add `.github/workflows/pi-compat.yml`.
- Done: make PR checks blocking for locked-package compatibility, boundary violations, and private-import violations.
- Done: make latest-Pi canary scheduled/dispatch issue-only.
- Future: include Pi compatibility status in any Letta drift issue when a default-toolset change implies new runtime semantics.

### Phase 3: Capability-aware activation

- Land issue #8.
- Keep activation policy based on canonical Pi capabilities.
- Add read-only Codex wrappers for `ReadFileCodex` and `ListDirCodex` if useful.
- Keep `exec_command` blocked until session manager exists.

### Phase 4: Experimental lanes

- Add `experimentalTools` config.
- Add smoke tests for inactive-but-registered tools.
- Run periodic real-model smoke against Codex/GPT and Gemini.

## What not to automate

- Do not auto-activate newly vendored tools.
- Do not auto-change canonical capability mappings.
- Do not silently replace `shell_command` with `exec_command`.
- Do not vendor all Letta tools into active profiles just because upstream defaults changed.
- Do not import private Pi internals to get around missing public primitives.
- Do not let latest-Pi canary failures block unrelated PRs; open a compatibility issue instead.

## North star

Letta can move fast. Pi moves too. Provider-tool-profiles should keep a fresh Letta snapshot, a clear Letta drift report, a Pi compatibility report, and a conservative activation policy.

The ideal sync loop is:

```text
detect Letta drift -> classify provider risk -> check Pi compatibility -> vendor safe files -> preserve capability boundaries -> open design issue for semantic/runtime changes
```

That keeps us close to Letta without turning provider-tool-profiles into an uncontrolled upstream runtime port, and keeps us close to Pi without depending on private internals.