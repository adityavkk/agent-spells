# Letta Code tool schema snapshot

Upstream: https://github.com/letta-ai/letta-code
Pinned ref: 2eca6e1354e37413e5b0840243ac208b8add7bd5
License: Apache-2.0, see upstream repository for full license text.

This extension vendors selected schema and description files only. Runtime implementations are local Pi wrappers.

Refresh:

```bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts 2eca6e1354e37413e5b0840243ac208b8add7bd5
```

Copied files:

- src/tools/schemas/Bash.json
- src/tools/descriptions/Bash.md
- src/tools/schemas/Read.json
- src/tools/descriptions/Read.md
- src/tools/schemas/Write.json
- src/tools/descriptions/Write.md
- src/tools/schemas/Edit.json
- src/tools/descriptions/Edit.md
- src/tools/schemas/MultiEdit.json
- src/tools/descriptions/MultiEdit.md
- src/tools/schemas/Glob.json
- src/tools/descriptions/Glob.md
- src/tools/schemas/Grep.json
- src/tools/descriptions/Grep.md
- src/tools/schemas/LS.json
- src/tools/descriptions/LS.md
- src/tools/schemas/ShellCommand.json
- src/tools/descriptions/ShellCommand.md
- src/tools/schemas/ExecCommand.json
- src/tools/descriptions/ExecCommand.md
- src/tools/schemas/WriteStdin.json
- src/tools/descriptions/WriteStdin.md
- src/tools/schemas/Shell.json
- src/tools/descriptions/Shell.md
- src/tools/schemas/ReadFileCodex.json
- src/tools/descriptions/ReadFileCodex.md
- src/tools/schemas/ListDirCodex.json
- src/tools/descriptions/ListDirCodex.md
- src/tools/schemas/ApplyPatch.json
- src/tools/descriptions/ApplyPatch.md
- src/tools/schemas/UpdatePlan.json
- src/tools/descriptions/UpdatePlan.md
- src/tools/schemas/ViewImage.json
- src/tools/descriptions/ViewImage.md
- src/tools/schemas/RunShellCommandGemini.json
- src/tools/descriptions/RunShellCommandGemini.md
- src/tools/schemas/ReadFileGemini.json
- src/tools/descriptions/ReadFileGemini.md
- src/tools/schemas/ReadManyFilesGemini.json
- src/tools/descriptions/ReadManyFilesGemini.md
- src/tools/schemas/ListDirectoryGemini.json
- src/tools/descriptions/ListDirectoryGemini.md
- src/tools/schemas/GlobGemini.json
- src/tools/descriptions/GlobGemini.md
- src/tools/schemas/SearchFileContentGemini.json
- src/tools/descriptions/SearchFileContentGemini.md
- src/tools/schemas/ReplaceGemini.json
- src/tools/descriptions/ReplaceGemini.md
- src/tools/schemas/WriteFileGemini.json
- src/tools/descriptions/WriteFileGemini.md
