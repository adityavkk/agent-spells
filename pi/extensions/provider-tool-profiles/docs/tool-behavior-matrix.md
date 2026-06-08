# Provider Tool Behavior Matrix

Issue: <https://github.com/adityavkk/agent-spells/issues/9>

## Purpose

Provider tool profiles expose Claude Code, Codex CLI, and Gemini CLI-style tools inside Pi. The model-facing contract comes from the provider harnesses and the Letta tool templates. The runtime contract comes from Pi.

This matrix records where those contracts align, where they conflict, and how an implementer should upgrade the provider tools without accidentally erasing provider-native behavior.

Target principle:

> Provider-native LLM contract, Pi-native safety/integration.

## Research baseline

Compared repo implementation against latest published Pi native tools:

- Pi latest checked: `@earendil-works/pi-coding-agent@0.79.0`
- Local/global Pi also inspected: `@earendil-works/pi-coding-agent@0.78.1`
- Native tool files inspected:
  - `dist/core/tools/read.js`
  - `dist/core/tools/write.js`
  - `dist/core/tools/edit.js`
  - `dist/core/tools/bash.js`
  - `dist/core/tools/grep.js`
  - `dist/core/tools/find.js`
  - `dist/core/tools/ls.js`
  - `dist/core/tools/truncate.js`
  - `dist/core/tools/path-utils.js`
  - `dist/core/tools/file-mutation-queue.js`
  - `dist/core/tools/render-utils.js`
- Pi docs consulted:
  - `docs/extensions.md`
  - `docs/tui.md`

Relevant repo files:

- `pi/extensions/provider-tool-profiles/tools/claude.ts`
- `pi/extensions/provider-tool-profiles/tools/codex.ts`
- `pi/extensions/provider-tool-profiles/tools/gemini.ts`
- `pi/extensions/provider-tool-profiles/tools/shared.ts`
- `pi/extensions/provider-tool-profiles/tools/rendering.ts`
- `pi/extensions/provider-tool-profiles/vendor/letta/*`

## Invariants to preserve

### Provider-facing invariants

- Keep provider tool names:
  - Claude: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Glob`, `Grep`, `LS`
  - Codex: `shell_command`, `apply_patch`, `update_plan`, `view_image`
  - Gemini: `run_shell_command`, `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `search_file_content`, `replace`, `write_file`
- Keep Letta/provider schemas unless a migration plan explicitly changes them.
- Keep provider-specific arg names and offset semantics.
- Keep provider-specific edit semantics where provider docs require them.

### Pi runtime invariants

- Tool renderers must never emit a rendered line wider than `width`.
- Tool renderers must not allow raw user/tool text to inject terminal controls.
- Mutating file tools must serialize same-file writes.
- Tools must respect abort signals.
- Large outputs must be truncated with useful continuation notices.
- Where possible, full truncated output should be available from a temp file.
- Runtime behavior differences should be documented and tested.

## Summary table

| Tool family | Current state | Pi native behavior | Recommendation |
| --- | --- | --- | --- |
| Read | Text-only custom read | Text + images, resizing, macOS path variants, better truncation | Delegate or adapt to Pi native read |
| Write | Basic write + local queue | Abort-aware write + realpath queue | Delegate or copy native behavior |
| Edit | Sequential literal replacements | Original-content normalized edits with diff/patch | Keep provider semantics, add Pi safety |
| Shell | `pi.exec("bash", ["-lc", ...])`, nonzero as text | configured shell/env, process-tree kill, streaming, temp file, errors on nonzero | Hybrid, explicit nonzero policy |
| Glob | `rg --files -g` | native `find` uses `fd`, limits, notices | Decide result semantics, add limits |
| Grep | raw `rg` modes | `rg --json`, match limits, long-line cap | Keep provider args, add native safety |
| LS | basic listing | default path, entry limit, notices | Low-risk native-like upgrade |
| Image | `view_image` reads common image types | native read handles resize/capability | Borrow native image handling |
| Patch/Plan | custom provider tools | no native equivalent | Keep custom, add safety/tests |

## Detailed matrix

### Claude `Read` and Gemini `read_file`

| Dimension | Current provider tool | Pi native read | Desired behavior |
| --- | --- | --- | --- |
| Args | Claude `file_path`, 1-based `offset`; Gemini `file_path`, 0-based `offset` | `path`, 1-based `offset`, `limit` | Keep provider args. Map to native args. Convert Gemini offset to 1-based for native call. |
| Path handling | `resolveToolPath()` strips leading `@`, expands `~` | `resolveReadPathAsync()` handles `@`, unicode spaces, macOS screenshot AM/PM, NFD, curly quotes | Use native path resolver via native read where possible. |
| Text truncation | simple head truncation, 2000 lines/50KB | line/byte truncation with first-line-too-large behavior and continuation offsets | Prefer native read output/details. |
| Images | unsupported except Codex `view_image` | detects supported image mimes, resizes, adds model non-vision notes | Use native read behavior for image reads. |
| Rendering | custom compact summary unless expanded | syntax highlighting, compact resource classification | Custom rendering is acceptable if TUI-safe, but native rendering is richer. |

Implementation direction:

- Use `createReadToolDefinition(ctx.cwd)` or equivalent native factory if feasible.
- Provider wrapper maps args, calls native `execute`, and returns native result.
- Keep provider render names if desired, or reuse native result rendering after arg mapping.

Tests:

- text read with offset/limit
- offset out of bounds
- image read path returns image block or model note
- macOS path variants if testable
- TUI width safety with long path/content

### Claude `Write` and Gemini `write_file`

| Dimension | Current provider tool | Pi native write | Desired behavior |
| --- | --- | --- | --- |
| Args | `file_path`, `content` | `path`, `content` | Straight arg map. |
| Parent dirs | creates parent dirs | creates parent dirs | Match native. |
| Queue | local in-extension queue by raw path | `withFileMutationQueue()` with realpath canonicalization | Use native queue. |
| Abort | no explicit post-await abort checks | checks abort before/after mkdir/write | Add native abort behavior. |
| Result | `Wrote <path>`, details bytes/path | `Successfully wrote N bytes to <path>`, details undefined | Decide whether provider-facing result text matters. Prefer native safety, document text divergence if changed. |
| Rendering | previews content | native highlights by file type and handles incremental streaming args | Custom TUI-safe preview okay. Native rendering richer. |

Implementation direction:

- Easiest: delegate to native write with `{ path: file_path, content }`.
- If retaining provider result text, copy native abort/queue structure.

Tests:

- creates parent dirs
- abort before write rejects/throws
- same-file concurrent writes serialize
- content preview remains TUI-safe

### Claude `Edit`, Claude `MultiEdit`, Gemini `replace`

| Dimension | Current provider tool | Pi native edit | Desired behavior |
| --- | --- | --- | --- |
| Args | Claude/Gemini use `old_string`/`new_string`; MultiEdit uses `edits` | native uses `edits: [{ oldText, newText }]` | Keep provider schemas. |
| Multi-edit semantics | sequential, each edit sees previous edit's result | native replacements matched against original normalized file | Keep provider sequential semantics because Letta/Claude docs specify it. |
| `replace_all` | supported | native requires unique replacement blocks, no provider `replace_all` | Keep provider behavior. |
| `expected_replacements` | supported for Gemini replace | native does not expose this exact contract | Keep provider behavior. |
| Empty `old_string` create-file behavior | Letta MultiEdit docs mention this | current behavior likely not sufficient | Verify and implement if provider contract requires it. |
| Atomicity | reads all, computes, writes once | native queue + write once | Preserve. |
| Line endings/BOM | not preserved deliberately | native strips/restores BOM, preserves line endings | Add native-style preservation. |
| Diff/details | replacements count only | native returns diff, patch, firstChangedLine | Add diff/patch details if possible. |

Implementation direction:

- Do not blind-delegate to native edit.
- Keep sequential provider algorithm.
- Wrap with `withFileMutationQueue()`.
- Borrow/copy native edit-diff helpers if public or reimplement narrowly with tests.
- Preserve BOM and original line endings.
- Return diff/patch details for improved rendering/review.

Tests:

- sequential MultiEdit where second edit depends on first
- overlapping edit cases documented as provider behavior
- `replace_all`
- `expected_replacements`
- BOM preservation
- CRLF preservation
- concurrent same-file edits serialize

### Claude `Bash`, Codex `shell_command`, Gemini `run_shell_command`

| Dimension | Current provider tool | Pi native bash | Desired behavior |
| --- | --- | --- | --- |
| Shell | `pi.exec("bash", ["-lc", command])` | configured shell from Pi shell config | Prefer native shell backend if accessible. |
| Environment | whatever `pi.exec` provides | `getShellEnv()` and spawn hook support | Prefer native. |
| Process kill | delegated to `pi.exec` | kills process tree | Prefer native process-tree behavior. |
| Streaming | no partial output streaming | throttled partial output via `onUpdate` | Add streaming. |
| Truncation | tail truncates to text only | output accumulator, temp file, detailed truncation metadata | Use native accumulator behavior if possible. |
| Nonzero exit | returned as successful text with `(exit n)` | throws, marks tool error | Decide explicitly. Provider harnesses often surface command failures as tool output. |
| Timeout units | provider schemas vary: Claude/Codex milliseconds, Pi native seconds | Pi native seconds | Normalize carefully. |

Nonzero policy options:

1. **Pi-native policy**: nonzero throws and marks tool result error.
2. **Provider-native policy**: nonzero returns normal tool result with exit code in text/details.
3. **Hybrid**: nonzero returns normal result, timeout/abort throw or mark error.

Recommendation: choose hybrid or provider-native, document it, and test it. Models from provider harnesses often expect command failure output to be inspectable without the harness treating the tool call itself as broken.

Tests:

- stdout/stderr merged ordering if possible
- nonzero command policy
- timeout policy
- abort kills child process tree
- long output writes temp file and includes continuation notice
- partial output updates

### Claude `Glob`, Gemini `glob`, Gemini `read_many_files`

| Dimension | Current provider tool | Pi native find | Desired behavior |
| --- | --- | --- | --- |
| Backend | `rg --files -g` | `fd --glob --hidden --no-require-git` | Decide whether provider result-set parity or Pi result-set parity matters. |
| Limits | generic truncation only | default result limit 1000 and byte truncation notices | Add explicit result limits/notices. |
| Gitignore | `rg --files` respects gitignore by default, option for Gemini no-ignore | native `fd` no-require-git semantics | Document and test. |
| Hidden files | depends on `rg` defaults; likely not hidden unless no-ignore flags | native includes `--hidden` | Decide and document. |
| `read_many_files` | expands globs then reads each file | no native exact equivalent | Keep custom, but use native read for each file. |

Implementation direction:

- For simple glob tools, either map to native `find` or keep `rg` and add native-like limits.
- For `read_many_files`, keep orchestration but call native read wrapper internally.

Tests:

- limit behavior
- hidden file behavior
- gitignored file behavior
- read_many skips binary/large files according to provider contract if needed

### Claude `Grep`, Gemini `grep_search`, Gemini `search_file_content`

| Dimension | Current provider tool | Pi native grep | Desired behavior |
| --- | --- | --- | --- |
| Backend | raw `rg` modes | `rg --json` | Keep provider args/output modes, but consider JSON backend for control. |
| Output modes | Claude supports `content`, `files_with_matches`, `count` | native always formats matching lines | Keep provider output modes. |
| Match limits | provider `head_limit` support, generic truncation | default 100 matches and explicit match-limit notices | Add explicit limits/notices. |
| Long lines | no specific long-line cap | truncates match lines to 500 chars | Add long-line cap. |
| Context | supports `-A/-B/-C` | supports context by reading files | Keep provider args, test formatting. |

Implementation direction:

- Do not blindly delegate to native grep because provider output modes differ.
- Borrow native ideas: JSON event parsing, match limits, long-line cap, truncation details.

Tests:

- each output mode
- context lines
- head limit/offset
- long line truncation
- byte truncation notice
- no matches

### Claude `LS`, Gemini `list_directory`

| Dimension | Current provider tool | Pi native ls | Desired behavior |
| --- | --- | --- | --- |
| Args | Claude `path` required; Gemini `dir_path` | native `path` optional default `.` and `limit` | Keep provider schemas; map to native if possible. |
| Ignore | provider supports ignore array | native has no ignore parameter | Keep custom filtering or pre/post-filter native result. |
| Limits | generic truncation | entry limit 500 and byte truncation notices | Add explicit limit behavior if schema permits, or fixed internal limit. |
| Sorting | locale sort | case-insensitive sort | Match native if no provider conflict. |

Implementation direction:

- Low-risk native-like implementation.
- Keep `ignore` support for Claude.
- Add internal entry limit and notice even if schema lacks `limit`.

Tests:

- empty directory text
- directory suffix `/`
- ignore patterns
- entry limit notice
- invalid path/not directory errors

### Codex `apply_patch`

| Dimension | Current provider tool | Pi native equivalent | Desired behavior |
| --- | --- | --- | --- |
| Contract | Codex-style `*** Begin Patch` format | no direct native equivalent | Keep custom. |
| Mutations | add/update/delete/move | n/a | Use Pi mutation queue per target file. |
| Atomicity | patch parser applies operations | n/a | Ensure multi-file failures do not leave partial state where possible, or document limits. |
| Diagnostics | basic parser errors | n/a | Improve parse/apply error messages. |
| Rendering | patch summary + preview | n/a | Current TUI-safe rendering okay. |

Implementation direction:

- Keep custom parser.
- Queue file mutations.
- Consider preflight validation before writes for stronger atomicity.

Tests:

- add/update/delete/move
- invalid patch diagnostics
- concurrent patch/edit same file
- TUI hostile patch preview

### Codex `update_plan`

| Dimension | Current provider tool | Pi native equivalent | Desired behavior |
| --- | --- | --- | --- |
| Contract | model-visible plan state | no native equivalent | Keep custom. |
| Persistence | in-memory `currentPlan` only | n/a | Consider session persistence if needed. |
| Rendering | plan result lines with status accents | n/a | Current TUI-safe rendering okay. |

Implementation direction:

- Keep custom.
- Decide whether plan should survive reload/session resume.

Tests:

- status rendering
- invalid/partial args
- persistence if implemented

### Codex `view_image`

| Dimension | Current provider tool | Pi native read image path | Desired behavior |
| --- | --- | --- | --- |
| Supported types | png, jpg, jpeg, gif, webp | native read detects supported image mimes | Expand to match native if possible. |
| Resize | none | native resizes inline images to model/provider limits | Borrow native behavior. |
| Model capability | no non-vision note | native notes when model lacks image support | Borrow native behavior. |
| Result | text + image block | text + image block | Match native details where useful. |

Implementation direction:

- Prefer using native read wrapper on image path.
- If keeping separate `view_image`, share native image handling.

Tests:

- supported type
- unsupported type
- oversized image resize path
- non-vision model note if accessible

## Implementation phases

### Phase 1: Matrix-driven tests

Add tests that pin desired behavior before large refactors:

- provider schema names and required fields stay unchanged
- renderer TUI safety remains green
- documented intentional divergences have tests

### Phase 2: Read/write native safety

- Adapt `Read`/`read_file` to native read behavior.
- Adapt `Write`/`write_file` to native write behavior or copy native queue/abort logic.

### Phase 3: Shell safety

- Add streaming updates.
- Add full-output temp files on truncation.
- Add process-tree kill/abort safety.
- Decide and test nonzero policy.

### Phase 4: Edit safety without semantic drift

- Preserve provider sequential edit semantics.
- Add queue, BOM/line-ending preservation, diff/patch details.
- Test provider examples from Letta descriptions.

### Phase 5: Search/list/glob output controls

- Add explicit match/result/entry limits.
- Add long-line caps.
- Add native-like truncation notices/details.

## Open questions

1. Should shell nonzero exits be tool errors or normal results?
2. Should provider tools reuse native renderers where possible, or maintain provider-specific labels/previews?
3. Should `update_plan` state be persisted into the session branch?
4. Should `read_many_files` mimic Gemini's binary/default-exclude behavior more strictly?
5. Should `apply_patch` be made multi-file atomic, or is preflight validation sufficient?

## Done criteria for implementation

- This matrix is updated as decisions are made.
- Every provider tool has documented desired behavior.
- All deliberate deviations from Pi native behavior are explicit.
- Provider schemas remain stable unless a migration note exists.
- TUI rendering tests remain exhaustive across narrow widths and hostile text.
- Mutating tools use Pi-compatible file mutation serialization.
- Output truncation is bounded and includes useful continuation guidance.
