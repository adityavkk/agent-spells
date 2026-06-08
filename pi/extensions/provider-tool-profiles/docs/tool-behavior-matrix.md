# Provider Tool Behavior Matrix and Implementation Plan

Issue: <https://github.com/adityavkk/agent-spells/issues/9>

Branch from issue comment: `docs/provider-tool-behavior-matrix-9`

## Goal

Build provider-shaped tool profiles for Claude Code, Codex CLI, and Gemini CLI without losing Pi runtime safety.

Target principle:

> Provider-native LLM contract, Pi-native safety/integration.

This means tool names, schemas, argument names, and model-facing quirks stay provider-native. Execution uses Pi primitives for path safety, cancellation, process handling, truncation, mutation serialization, image handling, and TUI-safe rendering.

## Current implementation status and next-agent handoff

Status as of 2026-06-08 on branch `docs/provider-tool-behavior-matrix-9`:

- Shipped commits:
  - `41d9cca feat: harden codex apply_patch path policy and preflight`
  - `38c4741 ci: add provider tool Pi compatibility checks`
  - `6f334d4 fix: enforce provider tool path policies`
  - `374df15 fix: use Pi mutation queue for provider files`
  - `a0e94f0 feat: add provider read write adapter foundations`
  - `a03770c feat: wire provider reads and writes through adapters`
  - `30ef63f feat: audit provider edits with read history`
  - `d3441b2 feat: add provider shell adapter foundation`
  - `7539ac6 fix: route provider shell tools through adapter`
  - `9d2bd49 feat: harden provider search and list adapters`
  - `18a5346 feat: persist Codex plans and share image reads`
- Verified locally after the latest runtime changes:
  - `bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts` -> 110 pass, 0 fail
  - `bun pi/extensions/provider-tool-profiles/scripts/check-pi-compat.ts --mode locked --output .tmp/pi-compat/locked-final-search-plan` -> green
  - `bun pi/extensions/provider-tool-profiles/scripts/check-pi-compat.ts --mode latest --pi-version latest --output .tmp/pi-compat/latest-final-search-plan` -> green
  - `bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main` -> clean (`changed=0 newSchemas=0 toolsetDiffs=0`)

### What is already done

1. **Codex `apply_patch` hardening**
   - Added `tools/path.ts` with the first explicit path policy: Codex patch paths are relative-only, POSIX-normalized, cwd-contained, and symlink-aware.
   - Codex patch paths now reject empty paths, NUL bytes, absolute POSIX/Windows paths, backslashes, `~`, `..`, and symlink escapes.
   - Reworked `tools/apply-patch.ts` into parse -> read-only preflight -> commit.
   - Preflight computes the full write plan in memory before disk mutation.
   - Commit has best-effort rollback from in-memory snapshots. It is not crash-safe atomicity.
   - Added tests in `tools/path.test.ts` and expanded `tools/apply-patch.test.ts` for path policy, preflight no-mutation, and commit rollback.

2. **Pi compatibility automation**
   - Added `tools/pi-compat.ts` as the provider-tool extension's public Pi API import boundary.
   - Rewired provider-tool runtime imports through that boundary.
   - Added `scripts/check-pi-compat.ts`.
     - Enforces no private Pi imports (`dist/**`, `core/**`, `src/**`, mode internals).
     - Enforces no direct Pi package imports outside `tools/pi-compat.ts`.
     - Smoke-tests required public exports, native tool factories, native read/write, and `createLocalBashOperations()`.
     - Supports locked mode and latest/canary mode in a temp dir without mutating this repo's lockfile.
   - Added `.github/workflows/pi-compat.yml`.
     - PRs block on provider-tool tests and locked Pi compatibility.
     - Schedule/dispatch runs latest canary and opens/updates `provider-tool-profiles: Pi compatibility drift` on failure.

3. **Active-tool path policy**
   - Expanded `tools/path.ts` into the explicit provider path-policy table.
   - Added `resolveClaudePath()` preserving current Claude behavior: absolute allowed, relative against `ctx.cwd`, leading `@` stripped, `~`/`~/` expanded, no `$VAR` expansion, NUL rejected early.
   - Added `resolveGeminiPath()` for cwd-contained Gemini file/search/list paths: relative allowed, absolute allowed only under `ctx.cwd`, parent segments/NUL/symlink escapes rejected.
   - Added `resolveExistingDirectoryUnderCwd()` for Codex `shell_command.workdir` and Gemini `run_shell_command.dir_path`: must exist, must be a directory, must stay under cwd.
   - Added `resolveCodexImagePath()` for Codex `view_image.path`: read-only absolute or relative path, leading `@` stripped, no cwd containment.
   - Wired Gemini `read_file`, `read_many_files`, `write_file`, `replace`, `glob.dir_path`, `grep_search.dir_path`, `search_file_content.dir_path`, `list_directory.dir_path`, and `run_shell_command.dir_path` through those policies.
   - Wired Codex `shell_command.workdir` and `view_image.path` through those policies.
   - Added helper-level and extension-level integration tests proving policy enforcement before mutation/exec.

4. **Pi mutation serialization**
   - Replaced the local provider-tool file queue with Pi's public `withFileMutationQueue()` through `tools/pi-compat.ts`.
   - Existing `withPathQueue()` remains as the provider-tool wrapper, so current adapters and `apply_patch` use Pi mutation serialization without broader rewrites.

5. **Read/write adapter foundation**
   - Added `tools/policies.ts` for provider behavior constants outside vendored Letta schema data.
   - Added `tools/results.ts` for typed provider results, explicit unsupported/deferred media messages, and Pi-public truncation notices.
   - Added `tools/read-history.ts` for session-local read audit records keyed by canonical path, with `missing` / `stale` / `fresh` checks.
   - Added `tools/runtime.ts` for shared per-session provider-tool runtime state.
   - Added `tools/read-adapter.ts` for provider-specific read behavior:
     - Claude `Read` returns `cat -n`-style line-numbered text with 1-based offsets.
     - Gemini `read_file` stays plain text with 0-based offsets.
     - Text reads record read-history.
     - Common image extensions return text plus image content.
     - PDF/audio/notebook/binary support returns explicit deferred/unsupported tool results.
   - Added `tools/write-adapter.ts` for queued writes with abort checks and read-history audit details.
   - Wired Claude `Read` / `Write` and Gemini `read_file` / `read_many_files` / `write_file` through the adapters.
   - Gemini `read_many_files` now has total file/byte caps and records text reads per included file.

6. **Edit adapter audit**
   - Added `tools/edit-adapter.ts` for queued provider exact edits with abort checks and read-history audit details.
   - Wired Claude `Edit`, Claude `MultiEdit`, and Gemini `replace` through the adapter.
   - Sequential edit semantics remain provider-compatible via `applyExactEditsToText()`; no delegation to Pi native edit semantics.

7. **Shell adapter hardening**
   - Added `tools/shell-adapter.ts` for Claude `Bash`, Codex `shell_command`, and Gemini `run_shell_command`.
   - Centralized shell timeout clamping, abort metadata, result formatting, tail truncation, and cwd/workdir validation.
   - Routed Codex/Gemini workdir fields through the existing cwd-contained existing-directory policy inside the adapter.
   - Codex `sandbox_permissions: "require_escalated"` now returns an explicit denied/unsupported result before exec.
   - Codex `justification` and non-empty `prefix_rule` now return explicit unsupported results before exec instead of being silently accepted without approval semantics.
   - Nonzero shell exits remain normal provider tool results with exit code details.
   - `run_in_background` remains explicitly unsupported for Claude `Bash` and is handled by the adapter before exec.
   - Provider shell invocation is now provider-aware:
     - Claude `Bash`: `bash -lc`.
     - Codex `shell_command`: `bash -lc` by default, `bash -c` when `login: false`.
     - Gemini `run_shell_command`: `bash -c`, matching the vendored schema description.
   - `createLocalBashOperations()` remains unused intentionally for now. It is public, but `ExtensionAPI.exec` preserves extension exec hooks and stdout/stderr result shape; the adapter keeps a future backend swap localized.

8. **Search/list adapter hardening**
   - Added `tools/ignore-policy.ts` for explicit provider ignore rule parsing and matching.
   - Added `tools/search-adapter.ts` for Claude `Glob`, Claude `Grep`, Gemini `glob`, Gemini `grep_search`, and Gemini `search_file_content`.
   - Added `tools/list-adapter.ts` for Claude `LS` and Gemini `list_directory`.
   - Removed search/list/glob helpers from `tools/shared.ts`; it now stays focused on file/process compatibility helpers.
   - Centralized ripgrep invocation, stable path sorting, result caps, truncation notices, and provider result details.
   - Glob output is newest-first with lexicographic tie-breaks.
   - Grep uses ripgrep path sorting for deterministic output.
   - Gemini search/list path inputs still use cwd-contained existing-directory validation from `tools/path.ts`.
   - Gemini `.geminiignore` handling is explicit for glob/grep/list; list also honors root `.gitignore` unless disabled by Gemini file filtering options.
   - `respect_git_ignore: false` maps to ripgrep `--no-ignore-vcs` for Gemini glob/search behavior.

9. **Codex plan and image cleanup**
   - Added `tools/plan-state.ts` for Codex `update_plan` session persistence via Pi public `appendEntry()` custom entries.
   - `update_plan` now appends `provider-tool-profiles.codex.plan.v1` custom session entries and reloads latest valid plan state from `ctx.sessionManager.getBranch()` on `session_start`.
   - `view_image` now routes through the shared image read path in `tools/read-adapter.ts` while preserving Codex's read-only absolute-or-relative path policy from `resolveCodexImagePath()`.

### Important boundaries for the next agent

- Do not edit native Pi packages. All work stays under `pi/extensions/provider-tool-profiles/**` plus CI/docs for that extension.
- Keep Letta/provider compatibility separate from Pi/runtime compatibility.
  - Letta drift: `scripts/check-letta-drift.ts`, `vendor/letta/*`, `.github/workflows/letta-drift.yml`.
  - Pi compatibility: `tools/pi-compat.ts`, `scripts/check-pi-compat.ts`, `.github/workflows/pi-compat.yml`.
- Do not activate vendored Codex `exec_command` / `write_stdin` / `shell` / `read_file` / `list_dir`.
- Do not broaden tool capabilities while aligning behavior.
- Do not import Pi internals to get a helper. If a primitive is not public, add a small local helper with tests or leave a design note.

### Known remaining gaps

- Shell execution remains backed by `ExtensionAPI.exec` intentionally. `createLocalBashOperations()` has not been adopted because it would bypass extension exec hooks and changes the stdout/stderr shape; this can be revisited inside `tools/shell-adapter.ts` only.
- Codex shell escalation/approval fields are denied/unsupported, not implemented. If Pi later exposes approval semantics, add them behind `tools/shell-adapter.ts` before broadening behavior.
- `.geminiignore` support is intentionally a simple line-based glob subset. Negated ignore rules are counted in result details but are not translated into ripgrep include overrides.
- Gemini list `.gitignore` support is also a simple root `.gitignore` line-based subset, not full Git ignore semantics. Ripgrep-backed search/glob still uses ripgrep's native ignore handling.
- `tools/shared.ts` still contains older file compatibility helpers (`readTextFile`, `writeTextFile`, `applyExactEdits`) for tests/legacy internals, though active provider tools are now routed through dedicated adapters.
- Blocked vendored Codex tools remain inactive: `exec_command`, `write_stdin`, `shell`, `read_file`, and `list_dir`.

### Recommended next slice

Recommended next work is polish/risk reduction, not a required adapter migration:

1. Tighten ignore semantics if needed:
   - Add fuller `.geminiignore` / `.gitignore` semantics, especially negation and nested ignore files, if provider parity requires it.
   - Keep implementation local to `tools/ignore-policy.ts`, `tools/search-adapter.ts`, and `tools/list-adapter.ts`.
2. Revisit shell backend only if Pi exposes shape-compatible public approval/exec primitives:
   - Keep all changes inside `tools/shell-adapter.ts`.
   - Do not silently implement Codex escalation or approval fields without real Pi approval semantics.
3. Optional rendering/docs polish:
   - Add renderer-specific details for capped search/list output if desired.
   - Update README examples for search/list/plan persistence if exposing this extension to users.
4. Keep Letta schemas untouched and Pi imports isolated to `tools/pi-compat.ts`.
5. Run before committing:

```bash
bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts
bun pi/extensions/provider-tool-profiles/scripts/check-pi-compat.ts --mode locked
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main
```

## Research baseline

### Local and issue context

- Issue 9 body and comment checked with `gh issue view 9 --comments`.
- Branch checked out and fast-forwarded: `docs/provider-tool-behavior-matrix-9`.
- Letta drift checked: `bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main`.
  - Result: no vendored schema, description, or default-toolset drift.
- Current implementation inspected:
  - `pi/extensions/provider-tool-profiles/tools/*.ts`
  - `pi/extensions/provider-tool-profiles/vendor/letta/*`
  - current tests under `pi/extensions/provider-tool-profiles/**/*test.ts`
- Pi public APIs inspected from local `@mariozechner/pi-coding-agent@0.73.1` and global `@earendil-works/pi-coding-agent@0.79.0` docs/dist.

### Search-tool prior art checked

Fetched via the `srch` SDK, not ad hoc browser notes:

| Source | URL | Relevant takeaways |
| --- | --- | --- |
| Claude Code tools reference | <https://code.claude.com/docs/en/tools-reference> | `Bash` has timeout/output limits and full-output files. `Edit`/`Write` require prior reads. `Glob` is mtime-sorted and capped. `Grep` uses ripgrep modes. `Read` returns line-numbered text and supports images/PDF/notebooks. |
| Letta Code snapshot | vendored from <https://github.com/letta-ai/letta-code> | Source of current schemas/descriptions. `MultiEdit` is sequential and atomic. `Read` says cat -n output, 2000-line default, images. `Bash` says 120s default, 10m max, 30k char cap. |
| Gemini CLI tools reference | <https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md> | File tools live under root/workspace safety. `grep_search` has legacy alias `search_file_content`. Official docs now mention argument-key drift versus Letta vendored schemas. |
| Gemini file tools | <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/file-system.md> | `read_file` is 0-based and supports text/images/audio/PDF. `glob` sorts newest first and respects ignore settings. `replace` is exact literal replacement. |
| Gemini shell tool | <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md> | `run_shell_command` returns command, directory, stdout, stderr, exit code, and background PIDs. Shell sets `GEMINI_CLI=1`. |
| OpenAI Codex CLI | <https://developers.openai.com/codex/cli> | Codex CLI can inspect, edit, run code, attach images, and use subagents. |
| Codex tool spec | <https://github.com/openai/codex/blob/99f47d6e9a3546c14c43af99c7a58fa6bd130548/codex-rs/core/src/tools/spec.rs> | Current Codex includes `shell_command`, `apply_patch`, `update_plan`, `view_image`; newer `exec_command`/`write_stdin` need session semantics. |
| Codex plan handler | <https://github.com/openai/codex/blob/99f47d6e9a3546c14c43af99c7a58fa6bd130548/codex-rs/core/src/tools/handlers/plan.rs> | `update_plan` is useful for input/rendering; tool output is just success text. At most one step may be `in_progress`. |
| Codex apply-patch grammar | <https://github.com/openai/codex/blob/35aaa5d9/codex-rs/apply-patch/apply_patch_tool_instructions.md> | Patch envelope has Add/Update/Delete/Move operations. Paths are relative, never absolute. Grammar is designed to be parseable and safe. |
| OpenAI Apply Patch API guide | <https://developers.openai.com/api/docs/guides/tools-apply-patch> | Patch workflows should report structured success/failure back to the model for iterative repair. |
| Community Pi Codex profile | <https://github.com/Graffioh/pi-codex-profile> | Adds Codex profile plus apply_patch. Paths restricted to cwd. Good small-scope example. |
| Community Pi apply-patch | <https://github.com/zrubing/pi-codex-apply-patch> | Shows atomic writes, path traversal checks, progress updates, and notes that forced patching improves auditability more than raw quality. |
| Community Pi Codex conversion | <https://github.com/adnichols/pi-codex-conversion> | Strong modular layout: adapter, tools, shell, patch, prompt, tests. Uses exec sessions plus `write_stdin`, which this project should not activate until semantics are designed. |

## Key correction to the first matrix

Directly delegating `Read`/`read_file` to Pi native read is too blunt. Prior art says provider reads often need provider-specific text formatting: Claude/Letta line-numbered `cat -n` style, Gemini 0-based ranges, and provider-specific truncation notices. Use Pi native image/path/truncation primitives, but keep provider text shape through a read adapter.

## Non-negotiable invariants

### Provider-facing

- Preserve active tool names:
  - Claude: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Glob`, `Grep`, `LS`
  - Codex: `shell_command`, `apply_patch`, `update_plan`, `view_image`
  - Gemini: `run_shell_command`, `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `search_file_content`, `replace`, `write_file`
- Preserve vendored Letta schemas unless a separate schema migration is planned.
- Preserve provider arg names and offset bases.
- Preserve provider edit semantics where docs require them: sequential `MultiEdit`, `replace_all`, `expected_replacements`, exact literal matching.
- Do not auto-activate vendored Codex `exec_command`, `write_stdin`, `shell`, `read_file`, or `list_dir` until Pi has explicit session/stdin/polling semantics.

### Pi runtime

- Use public Pi APIs only. No deep imports from `dist/core/**`.
- Mutating tools use `withFileMutationQueue()` for the whole read-modify-write window.
- Abort signals are checked before and after awaited filesystem/process operations.
- Output is bounded, with explicit notices and full-output temp files when useful.
- Shell process handling comes from Pi shell operations where possible, not custom `spawn`.
- Renderers sanitize terminal controls and never return lines wider than `width`.
- Deliberate divergence from native Pi behavior is documented and tested.

## Decision summary

| Area | Decision | Rationale |
| --- | --- | --- |
| Package boundary | Done: `tools/pi-compat.ts` is the import boundary for public Pi APIs. Use current `@mariozechner/*` in this repo, but keep the boundary ready for `@earendil-works/*`. | Avoid global package-name churn across implementation files. |
| Native reuse | Reuse public Pi factories/utilities for operations, queues, truncation, shell execution, and rendering helpers when shapes match. | Prevent reimplementing Pi internals. |
| Path policy | Implement a per-profile/per-tool path policy table. Patch is relative-only. Gemini mutation/search/list stays cwd-contained. Claude file tools keep absolute-path support. | Avoid accidental filesystem broadening or narrowing. Provider docs conflict here, so the policy must be explicit and tested. |
| Read | Hybrid, not raw delegation. Native-compatible path/image/truncation; provider-specific text formatting and offset mapping. | Direct Pi output would drift from Claude/Letta line-numbered reads and Gemini 0-based reads. |
| Read history | Add session-local read-history audit for edit/write. Default is audit-only; strict enforcement is out of scope for this issue. | Captures Claude read-before-edit intent without surprising users on first safety pass. |
| Media | Implement text and image support now. PDF, audio, and notebooks return explicit unsupported/deferred results. | Pi public native support is image-focused; silent capability drops are worse than clear unsupported output. |
| Write | Use native write semantics plus provider result text policy. Audit read-before-overwrite. | Safety now, low model-visible risk. |
| Edit | Keep provider sequential semantics. Add Pi queue, BOM/line-ending preservation, diffs, and better diagnostics. | Pi native edit matches all edits against original content, which conflicts with provider `MultiEdit`. |
| Shell | Use Pi `createLocalBashOperations()` or equivalent shell backend. Nonzero exit is a normal provider result with exit code. Timeout/abort are errors. Security-affecting unsupported args are denied, not ignored. | Provider harnesses expose command failures as inspectable output; sandbox escalation must never be silently accepted. |
| Search/glob/list | Keep provider result-set semantics by profile. Claude Glob uses vendored Letta cap 2000 for now. Borrow Pi limits, long-line caps, notices, and abort handling. | Provider defaults conflict with Pi native `find`/`grep`; vendored docs win until Letta drift changes. |
| Image | Prefer Pi native image read/resize/capability behavior. Keep Codex `view_image` wrapper. | Avoid oversized image payloads and non-vision confusion. |
| Apply patch | Keep custom. Enforce Codex relative-path-only policy. Preflight into an in-memory write plan, then commit under stable ordered queues with best-effort in-memory rollback on commit error. | Codex grammar has no Pi native equivalent and absolute paths are explicitly forbidden. Crash-safe multi-file atomicity is out of scope. |
| Update plan | Keep custom. Validate one `in_progress`. Persist plan in session entries and restore on `session_start`. | Inputs are the important artifact; output can stay minimal. |

## Path policy

Implement this before changing behavior. Tests must cover absolute paths, relative paths, `~`, leading `@`, NUL bytes, `..`, symlinks, and cwd escape attempts.

| Profile/tool group | Path policy | Notes |
| --- | --- | --- |
| Claude `Read`, `Write`, `Edit`, `MultiEdit`, `Glob.path`, `Grep.path`, `LS.path` | Absolute allowed; relative resolves against `ctx.cwd`; leading `@` stripped; `~`/`~/` stays expanded for current Pi compatibility; `$VAR` is not expanded. | Matches current capability and Claude/Letta absolute-path expectations. Document `~` expansion as a Pi compatibility divergence from Letta's literal-path wording. |
| Gemini `write_file`, `replace`, `glob.dir_path`, `grep_search.dir_path`, `search_file_content.dir_path`, `list_directory.dir_path` | Must resolve under `ctx.cwd` after symlink/canonicalization. Relative paths allowed. Absolute paths allowed only if under `ctx.cwd`. | Matches Gemini `rootDirectory`/workspace safety. |
| Gemini `read_file`, `read_many_files` | Same cwd-contained default as other Gemini tools. If a future user need requires temp screenshots outside cwd, add an explicit config flag and tests. | Avoid silent broad reads in Gemini profile. |
| Codex `apply_patch` | Done: relative-only, POSIX-normalized, cwd-contained. Rejects NUL, absolute POSIX, absolute Windows, empty, `..`, backslashes, `~`, and symlink escape. | Codex apply-patch instructions say file references are never absolute. |
| Codex `shell_command.workdir` | Must resolve under `ctx.cwd`; default `ctx.cwd`; reject missing or non-directory workdirs. | Avoid shell execution from surprising directories. |
| Codex `view_image.path` | Absolute or relative read-only image path allowed; leading `@` stripped; no mutation. | Codex prior art says use full local image paths supplied by the user. |
| Shell commands themselves | Path policy applies only to tool args, not shell internals. | Shell can still access what the OS/user permits; Pi permission/sandbox systems remain the enforcement layer. |

## Read-history audit design

Default for this issue: audit only, never block. Strict enforcement can be a later config flag.

- Store session-local `Map<canonicalPath, ReadRecord>`.
- `ReadRecord`: `{ path, profile, toolName, mtimeMs, size, sha256, readAtTurnId? }`.
- Canonicalize with realpath for existing files; resolved absolute path for missing files.
- Successful `Read`, `read_file`, and `read_many_files` text reads count. Image reads count only for image overwrite audit, not text edit confidence.
- Shell commands do not count as reads in v1. Recognizing `cat`/`sed`/`grep` can be a later narrow feature.
- Before write/edit, stat and hash the file if it exists:
  - no record -> details include `readHistory: "missing"`
  - hash/mtime mismatch -> details include `readHistory: "stale"`
  - match -> details include `readHistory: "fresh"`
- Renderers may show audit state in compact form, but LLM-facing text stays concise.

## Media scope

Phase 2 supports text and common images (`png`, `jpg`, `jpeg`, `gif`, `webp`) through Pi-compatible image handling.

Explicitly deferred for all profiles unless Pi exposes a public primitive or a later issue scopes it:

- PDF page extraction
- audio transcription/attachment
- Jupyter notebook semantic rendering/editing

Deferred media must return a clear tool result, not a silent text read of binary bytes. Suggested text: `Unsupported media type for <path>: PDF/audio/notebook support is deferred. Use shell tools or convert the file to text/image first.`

## Target architecture

### Data flow

```text
provider tool call
  -> provider contract adapter
  -> provider policy lookup
  -> Pi runtime facade or provider-specific engine
  -> result normalizer
  -> TUI-safe renderer
```

### Suggested module layout

Keep modules small, testable, and mostly pure.

| Module | Responsibility |
| --- | --- |
| `tools/pi-compat.ts` | All imports from Pi public APIs. Current package-name shim. |
| `tools/contracts.ts` | Shared `ProviderProfile`, `ProviderPolicy`, `ProviderToolAdapter` types. |
| `tools/policies.ts` | Claude/Codex/Gemini behavior constants: offset base, caps, shell policy, glob ignore policy. |
| `tools/path.ts` | Path-policy enforcement, cwd containment, symlink checks, relative-only patch validation. |
| `tools/results.ts` | Text/image result helpers, truncation notices, full-output temp-file references. |
| `tools/read-adapter.ts` | Text/image read orchestration and provider-specific formatting. |
| `tools/read-history.ts` | Session-local read audit records for edit/write freshness. |
| `tools/write-adapter.ts` | Native-safe writes and read-history audit details. |
| `tools/edit-adapter.ts` | Sequential provider exact edits, BOM/line-ending preservation, diff/patch details. |
| `tools/shell-adapter.ts` | Provider shell wrappers over Pi shell operations, streaming, timeout, nonzero policy. |
| `tools/search-adapter.ts` | Glob/grep/read_many providers, limits, mtime sorting, ignore policy. |
| `tools/list-adapter.ts` | `LS`/`list_directory` with ignore patterns and entry limits. |
| `tools/patch-adapter.ts` | Codex patch parser, preflight, path policy, queued execution. |
| `tools/plan-state.ts` | `update_plan` validation, session persistence, and restore. |
| `tools/rendering.ts` | Current TUI-safe rendering helpers. Keep all terminal sanitization here. |
| `tools/register.ts` | Thin registration layer per provider, no business logic. |

### Core types

```ts
type ProviderProfile = "claude" | "codex" | "gemini";

type ShellFailurePolicy = "nonzero-as-result" | "nonzero-as-error";

type ProviderPolicy = {
  profile: ProviderProfile;
  readOffsetBase: 0 | 1;
  readTextFormat: "plain" | "cat-n";
  shellFailurePolicy: ShellFailurePolicy;
  glob: {
    sort: "mtime-desc" | "alpha";
    respectGitIgnoreDefault: boolean;
    includeHiddenDefault: boolean;
    resultLimit: number;
  };
  grep: {
    outputLimitChars: number;
    maxLineChars: number;
  };
};

type ProviderToolResult<Details = unknown> = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: Details;
  terminate?: boolean;
};

type ReadHistory = {
  recordRead(path: string, result: { mtimeMs: number; size: number; sha256: string }): void;
  checkFreshness(path: string): Promise<"missing" | "stale" | "fresh">;
};

type RuntimeContext = {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (result: ProviderToolResult) => void;
  model?: unknown;
  readHistory: ReadHistory;
};

type ProviderToolAdapter<ProviderArgs, NativeArgs, Details = unknown> = {
  providerName: string;
  policy: ProviderPolicy;
  mapArgs(args: ProviderArgs, ctx: { cwd: string }): NativeArgs;
  execute(args: ProviderArgs, runtime: RuntimeContext): Promise<ProviderToolResult<Details>>;
};
```

Do not over-abstract registration. The goal is shared execution behavior, not a generic framework.

## Desired per-tool behavior

| Tool family | Desired behavior | Reuse | Do not do |
| --- | --- | --- | --- |
| Claude `Read`, Gemini `read_file` | Map provider offsets. Text gets provider formatting and continuation notices. Images use Pi image detection/resizing/model-capability notes. Unsupported media gets explicit deferred text. | Pi read path/image helpers if public, `truncateHead`. | Do not return raw Pi text for Claude/Letta if line-numbered output is required. Do not read binary media as UTF-8. |
| Gemini `read_many_files` | Expand globs with Gemini ignore defaults, then call read adapter per file. Bound total files and bytes. Record read-history for every text file included. | Shared glob/read adapters. | Do not concatenate unbounded files. |
| Claude `Write`, Gemini `write_file` | Create dirs, write atomically enough for local fs, queue by canonical path, check abort after awaits. Include read-history audit details. | Pi `createWriteToolDefinition` or `withFileMutationQueue`. | Do not write outside mutation queue. |
| Claude `Edit`/`MultiEdit`, Gemini `replace` | Sequential exact literal edits. `replace_all` and `expected_replacements` honored. Preserve BOM and line endings. Return diff/patch details. | Pi queue, truncation, maybe public `renderDiff` only. | Do not delegate to Pi native edit because semantics differ. |
| Claude `Bash`, Codex `shell_command`, Gemini `run_shell_command` | Provider args and result text. Nonzero returns normal output with exit code. Timeout/abort fail. Stream partial output. Full output saved on truncation. Unsupported background/session fields return explicit unsupported results. Codex `sandbox_permissions: "require_escalated"` returns denied/unsupported unless Pi has an approval path. | Pi `createLocalBashOperations`, `truncateTail`, temp files. | Do not use raw `spawn` or `pi.exec("bash", ["-lc"])` long term. Do not ignore security-affecting args. |
| Claude `Glob`, Gemini `glob` | Profile-specific ignore policy, mtime-desc sorting where provider docs expect it, result limits, truncation notices. | Shared process runner or native-safe fd/rg helpers. | Do not silently switch Claude/Gemini to Pi native `find` result semantics. |
| Claude `Grep`, Gemini `grep_search`/`search_file_content` | Keep output modes and aliases. Use regex/literal/case/context options per schema. Cap matches and long lines. | Pi grep ideas: `rg --json`, long-line cap, notices. | Do not drop provider output modes. |
| Claude `LS`, Gemini `list_directory` | Provider args, ignore patterns, directory suffixes, entry limit, case-insensitive sort. | Pi `ls` ideas and truncation. | Do not omit ignore support. |
| Codex `apply_patch` | Parse Codex envelope. Reject absolute/traversal paths. Preflight all ops into an in-memory write plan. Queue all touched files in stable order. Commit with best-effort rollback from in-memory snapshots if a write/delete/rename fails. Return per-file status. | Existing parser plus Pi queue/truncation. | Do not allow absolute paths, cwd escape, or claims of crash-safe atomicity. |
| Codex `update_plan` | Validate statuses and single `in_progress`. Render current plan. Persist latest plan via `pi.appendEntry()` and restore on `session_start`. | Existing renderer/session APIs. | Do not make plan output verbose to the model. |
| Codex `view_image` | Local image path only. Use Pi image resize/capability behavior. | Read image adapter. | Do not base64 huge images without resize. |

## Implementation plan

### Phase 0: Baseline and contract tests first

Deliverables:

- Add golden tests for every current provider tool name and schema export.
- Add behavior tests from prior art:
  - Claude/Letta read offset, line-number formatting, image read.
  - Gemini 0-based read offsets.
  - Sequential `MultiEdit` where edit 2 depends on edit 1.
  - `replace_all` and `expected_replacements`.
  - Shell nonzero as result, timeout as error, abort as error.
  - Shell security fields: `sandbox_permissions: "require_escalated"` is denied/unsupported, not ignored.
  - Path policy: cwd escape, symlink escape, NUL, `~`, leading `@`, and absolute paths per profile.
  - Patch relative-path rejection and rollback-on-commit-error.
  - Deferred media returns explicit unsupported text.
- Keep existing TUI hostile-text width tests green.

Agent handoff:

1. Write tests that fail against current gaps.
2. Do not refactor tool registration yet.
3. Commit only tests if requested by project workflow owner.

### Phase 1: Foundation modules

Deliverables:

- `pi-compat.ts` with public Pi imports only:
  - `withFileMutationQueue`
  - `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`
  - `createLocalBashOperations`
  - native tool definitions where directly safe
- `policies.ts` for provider constants.
- `path.ts` for path-policy enforcement, cwd containment, symlink checks, and patch path validation.
- `read-history.ts` for read audit keying, hashing, and freshness checks.
- `results.ts` for result helpers, unsupported-field results, and truncation notice builders.

Rules:

- No business logic in `claude.ts`, `codex.ts`, or `gemini.ts` after this phase.
- No deep imports from Pi internals.
- Each helper gets direct unit tests.

### Phase 2: Read, write, image

Deliverables:

- `read-adapter.ts`:
  - provider offset mapping
  - provider text formatting
  - image path handling through Pi-compatible image behavior
  - actionable continuation notices
- `write-adapter.ts`:
  - `withFileMutationQueue()` across mkdir/write
  - abort checks before and after awaits
  - canonical path details
- `view_image` uses the shared image read path.

Notes:

- Implement read-history exactly as described above. Audit state goes into `details`, not long model-facing prose.
- If Pi image internals are not exposed enough, wrap native `createReadToolDefinition()` for image paths and normalize result text only.
- PDF/audio/notebook support is deferred with explicit unsupported results.

### Phase 3: Edit safety without semantic drift

Deliverables:

- `edit-adapter.ts` with provider sequential edits.
- Preserve BOM and original line endings.
- Add diff/patch details and first-changed-line if practical.
- Queue by canonical file path for the full read-modify-write.
- Read-before-edit audit details using `read-history.ts`; no blocking in this issue.

Required tests:

- sequential edit dependency
- conflicting edit diagnostics
- empty `old_string` creates a new file for Claude `MultiEdit` if this stays in prompt contract
- CRLF and BOM preservation
- same-file concurrent edits serialize
- diff details stable enough for TUI rendering

### Phase 4: Shell runner

Deliverables:

- `shell-adapter.ts` over Pi shell operations.
- Provider wrappers:
  - Claude `Bash`: `command`, `timeout`, unsupported `run_in_background` still explicit.
  - Codex `shell_command`: `command`, `workdir`, `timeout_ms`; `login` recorded if unsupported; `sandbox_permissions: "require_escalated"`, `justification`, and `prefix_rule` return explicit denied/unsupported unless Pi approval semantics are implemented.
  - Gemini `run_shell_command`: `command`, `dir_path`; background/session fields return explicit unsupported results until session semantics exist.
- Streaming partial output through `onUpdate`.
- Tail truncation, full-output temp file, and consistent details.

Decision:

- Nonzero exit returns a normal tool result with `exitCode` and output.
- Timeout and abort throw errors so Pi marks the tool failed.

Required tests:

- stdout/stderr captured
- nonzero inspectable by model
- timeout text includes partial output
- abort stops process tree through Pi operations
- long output writes a temp file and includes the path

### Phase 5: Search, glob, list, read_many

Deliverables:

- `search-adapter.ts` for glob/grep/read_many.
- Profile policies:
  - Claude Glob: mtime-desc, cap 2000 from vendored Letta docs, default no `.gitignore` filtering to match Claude Code prior art.
  - Gemini Glob: mtime-desc, `respect_git_ignore` default true, nuisance dirs excluded.
  - Claude/Gemini Grep: keep provider modes and aliases; respect `.gitignore` by default; add long-line cap and match notices.
- `list-adapter.ts` with ignore patterns, entry cap, directory suffixes.

Required tests:

- hidden/gitignored behavior per profile policy
- mtime sort
- result caps and continuation notices
- grep output modes: `content`, `files_with_matches`, `count`
- Gemini `read_many_files` total cap and binary skip behavior if implemented

### Phase 6: Codex patch and plan

Deliverables:

- `patch-adapter.ts`:
  - relative-path-only validation
  - reject NUL, absolute POSIX, absolute Windows, `..` traversal, and symlink escape
  - parse plus apply hunks in memory before touching disk
  - compute a write plan: create, update, delete, move, previous in-memory snapshot
  - stable lock ordering for multi-file patches to avoid deadlocks
  - commit under locks; on commit error, best-effort rollback from in-memory snapshots
  - per-file result details; never claim crash-safe atomicity
- `plan-state.ts`:
  - status validation
  - only one `in_progress`
  - session persistence through `pi.appendEntry()` and restore on `session_start`

Required tests:

- add/update/delete/move
- parser diagnostics
- absolute/traversal path rejection
- preflight creates no on-disk changes
- commit failure triggers rollback attempt and reports rollback status
- one `in_progress` validation
- plan restore from persisted session entry

### Phase 7: Activation, docs, smoke

Deliverables:

- Keep provider activation behavior unchanged unless tests prove a bug.
- Update `README.md` known gaps after implementation.
- Add smoke prompts for each profile covering read, edit, shell failure, search, and image.
- Run:

```bash
bun test pi/extensions/provider-tool-profiles/*.test.ts pi/extensions/provider-tool-profiles/tools/*.test.ts
bun pi/extensions/provider-tool-profiles/scripts/check-letta-drift.ts --ref main
```

## CI compatibility workflows

Keep two independent compatibility checks in CI:

| Workflow | Protects | Trigger | PR behavior | Scheduled behavior |
| --- | --- | --- | --- | --- |
| Letta drift | Provider-facing schema/descriptions/default toolsets | existing `.github/workflows/letta-drift.yml` | report drift; fail only on tooling/test errors | open/update `provider-tool-profiles: Letta drift` |
| Pi compatibility | Pi public runtime APIs, native tool primitives, result shapes, TUI contracts | `.github/workflows/pi-compat.yml` | fail on locked-package test failures, private Pi imports, boundary violations, renderer regressions, or missing public exports | open/update `provider-tool-profiles: Pi compatibility drift` for latest-Pi canary failures |

Pi compatibility check scope:

- Run current provider-tool-profiles tests against the locked dependency set.
- Assert provider-tool-profiles imports Pi only through `tools/pi-compat.ts` and public package exports, not `dist/**` or private `core/**` paths.
- Smoke import the public Pi primitives the hybrid adapters depend on:
  - `withFileMutationQueue`
  - `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`
  - `createLocalBashOperations`
  - native tool factories for read/write/edit/bash/list/grep/find
- Instantiate native tool definitions against a temp cwd and verify result details still expose expected truncation/full-output fields where relevant.
- Upload `.tmp/pi-compat/summary.md` and `.tmp/pi-compat/recommended-actions.md` artifacts.

Activation rule for agents: do not activate a Letta-driven tool change unless both the Letta drift decision and the Pi compatibility check are green for the affected capability. If Letta wants a tool whose semantics need missing Pi primitives, vendor it and mark it `blocked`.

## Acceptance criteria

- All provider tool names and schemas remain stable.
- Every provider tool has documented desired behavior and tests for intentional Pi divergence.
- No provider renderer emits terminal control sequences from tool/user text.
- No rendered line exceeds terminal width in narrow-width tests.
- Mutating tools use Pi-compatible file mutation serialization.
- Shell long output is bounded and recoverable from a temp file.
- Nonzero shell behavior is explicitly tested as provider-native normal result.
- Path policy tests pass for absolute, relative, `~`, leading `@`, NUL, `..`, symlink escape, and cwd escape cases.
- Security-affecting unsupported shell args produce explicit denied/unsupported results.
- Deferred media types produce explicit unsupported results.
- `apply_patch` cannot write outside cwd and does not mutate disk before preflight completes.
- `update_plan` restores latest plan after session reload/resume when session persistence is available.
- Letta drift report remains clean or documented.
- Pi compatibility check is documented and, once implemented, reports locked-package status plus latest-Pi canary status.
- No implementation agent adds private Pi imports to satisfy hybrid behavior.

## Deferred, not blocking this issue

- Strict Claude read-before-edit/write enforcement. This issue records audit details only.
- Gemini schema migration from vendored `offset`/`limit` to newer official `start_line`/`end_line`. Stay vendored until Letta changes or a migration issue is opened.
- PDF/audio/notebook support. Return explicit unsupported results until scoped separately.
- Codex `exec_command`/`write_stdin` activation. Implement as a separate feature branch with explicit session/stdin/polling UX.
- Crash-safe multi-file patch atomicity. This issue implements in-memory preflight plus best-effort rollback, not journaling or fs-level transactions.

## Best-practice guidance for implementation agents

- Change one tool family per PR or agent handoff.
- Start each family with tests that pin provider contract and Pi safety invariants.
- Prefer small adapters over global rewrites.
- Keep registration files thin.
- Use public Pi APIs. If a needed primitive is not public, either add a narrow local helper with tests or open an upstream Pi export request.
- Do not broaden capabilities while aligning behavior. New Letta schemas do not mean newly active tools.
- Do not sacrifice provider behavior merely to reuse a Pi native tool. Reuse Pi internals only behind an adapter that preserves the model-visible contract.
