import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
	editTextFile,
	globFiles,
	grepFiles,
	listDirectory,
	multiEditTextFile,
	readTextFile,
	runShell,
	textResult,
	writeTextFile,
} from "./shared";

export function registerClaudeTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "Bash",
		label: "Bash",
		description: "Execute a shell command in the current workspace. Foreground execution only.",
		parameters: Type.Object({
			command: Type.String({ description: "Command to execute" }),
			description: Type.Optional(Type.String({ description: "Short description of what the command does" })),
			timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Background execution is not supported by this adapter" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.run_in_background) return textResult("run_in_background is not supported by this Pi adapter.", { unsupported: true });
			return runShell({ pi, ctx, command: params.command, timeoutMs: params.timeout, signal });
		},
	});

	pi.registerTool({
		name: "Read",
		label: "Read",
		description: "Read a file. Returns text with 1-based line numbers.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to read, absolute or relative to cwd" }),
			offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await readTextFile({
				cwd: ctx.cwd,
				filePath: params.file_path,
				offset: params.offset,
				limit: params.limit,
				offsetBase: 1,
				numberLines: true,
			}));
		},
	});

	pi.registerTool({
		name: "Write",
		label: "Write",
		description: "Create or overwrite a file.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to write, absolute or relative to cwd" }),
			content: Type.String({ description: "Complete file content" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = await writeTextFile(ctx.cwd, params.file_path, params.content);
			return textResult(`Wrote ${params.content.length} bytes to ${params.file_path}`, { path });
		},
	});

	pi.registerTool({
		name: "Edit",
		label: "Edit",
		description: "Replace exact text in a file. The old_string must match literally.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to edit, absolute or relative to cwd" }),
			old_string: Type.String({ description: "Exact text to replace" }),
			new_string: Type.String({ description: "Replacement text" }),
			replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await editTextFile({
				cwd: ctx.cwd,
				filePath: params.file_path,
				oldString: params.old_string,
				newString: params.new_string,
				replaceAll: params.replace_all,
			});
			return textResult(`Applied ${result.replacements} replacement(s) to ${params.file_path}`, result);
		},
	});

	pi.registerTool({
		name: "MultiEdit",
		label: "MultiEdit",
		description: "Apply multiple exact text replacements to one file atomically.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to edit, absolute or relative to cwd" }),
			edits: Type.Array(Type.Object({
				old_string: Type.String({ description: "Exact text to replace" }),
				new_string: Type.String({ description: "Replacement text" }),
				replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await multiEditTextFile({ cwd: ctx.cwd, filePath: params.file_path, edits: params.edits });
			return textResult(`Applied ${result.replacements} replacement(s) to ${params.file_path}`, result);
		},
	});

	pi.registerTool({
		name: "Glob",
		label: "Glob",
		description: "Find files by glob pattern.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts" }),
			path: Type.Optional(Type.String({ description: "Directory to search from" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult((await globFiles(ctx.cwd, params.pattern, params.path)).join("\n") || "No files found");
		},
	});

	pi.registerTool({
		name: "Grep",
		label: "Grep",
		description: "Search file contents with ripgrep.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex pattern" }),
			path: Type.Optional(Type.String({ description: "Directory or file to search" })),
			include: Type.Optional(Type.String({ description: "Glob include filter" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return grepFiles({ pi, ctx, pattern: params.pattern, dirPath: params.path, include: params.include, signal });
		},
	});

	pi.registerTool({
		name: "LS",
		label: "LS",
		description: "List files and directories.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory to list" })),
			ignore: Type.Optional(Type.Array(Type.String({ description: "Exact entry name to ignore" }))),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await listDirectory(ctx.cwd, params.path ?? ".", params.ignore ?? []));
		},
	});
}

