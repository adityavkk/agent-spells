# Provider tool profile smoke prompts

Manual A/B notes for edit reliability. Run once with this extension enabled and once disabled.

## Claude

Model: Anthropic Claude.
Expected active core tools: `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`.

Prompt:

```text
Create .tmp/provider-tools-claude.txt with three lines, read it, replace the middle line with Edit, then use MultiEdit to change first and last lines. Show the final file.
```

Success:

- Uses `Write`, `Read`, `Edit`, then `MultiEdit`.
- No calls to lowercase Pi `edit`/`write`.
- Final file has all three intended changes.

## Codex / GPT

Model: OpenAI Codex or GPT.
Expected active core tools: `shell_command`, `apply_patch`, `update_plan`, `view_image`.

Prompt:

```text
Use a short plan, create .tmp/provider-tools-codex.txt with apply_patch, then update its contents with another patch. Show git diff for that file.
```

Success:

- Uses `update_plan` and `apply_patch` for file changes.
- Uses `shell_command` for `git diff`.
- Patch application is exact and local-only.

## Gemini

Model: Gemini / Google.
Expected active core tools: `run_shell_command`, `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`/`search_file_content`, `replace`, `write_file`.

Prompt:

```text
Create .tmp/provider-tools-gemini.txt with write_file, read it with read_file, replace one line with replace, then find the file with glob and grep for the changed line.
```

Success:

- Uses Gemini-style snake-case tools.
- `replace` honors expected replacement count.
- `glob` and `grep_search` or `search_file_content` find the file/content.

## Regression checks

- Switch from Claude to Codex to unknown local model in one Pi session.
- Confirm unrelated extension tools remain active.
- Confirm Pi default tools restore when unknown model selected.
- Confirm `.pi/provider-tool-profiles.json` can disable a profile.
