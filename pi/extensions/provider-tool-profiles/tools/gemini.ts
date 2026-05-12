import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
	editTextFile,
	globFiles,
	grepFiles,
	listDirectory,
	readManyFiles,
	readTextFile,
	runShell,
	textResult,
	writeTextFile,
} from "./shared";

export function registerGeminiTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "run_shell_command",
		label: "Run Shell Command",
		description: "Execute a shell command in dir_path or cwd.",
		parameters: Type.Object({
			command: Type.String({ description: "Command to execute" }),
			description: Type.Optional(Type.String({ description: "Short description" })),
			dir_path: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runShell({ pi, ctx, command: params.command, workdir: params.dir_path, signal });
		},
	});

	pi.registerTool({
		name: "read_file",
		label: "Read File",
		description: "Read a text file. Offset is 0-based.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to read" }),
			offset: Type.Optional(Type.Number({ description: "0-based line offset" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await readTextFile({
				cwd: ctx.cwd,
				filePath: params.file_path,
				offset: params.offset,
				limit: params.limit,
				offsetBase: 0,
				numberLines: false,
			}));
		},
	});

	pi.registerTool({
		name: "read_many_files",
		label: "Read Many Files",
		description: "Read and concatenate files matching include globs.",
		parameters: Type.Object({
			include: Type.Array(Type.String({ description: "Glob pattern to include" })),
			exclude: Type.Optional(Type.Array(Type.String({ description: "Glob pattern to exclude" }))),
			recursive: Type.Optional(Type.Boolean({ description: "Accepted for Gemini compatibility" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await readManyFiles({
				cwd: ctx.cwd,
				include: params.include,
				exclude: params.exclude,
				recursive: params.recursive,
			}));
		},
	});

	pi.registerTool({
		name: "list_directory",
		label: "List Directory",
		description: "List files and directories.",
		parameters: Type.Object({
			dir_path: Type.String({ description: "Directory to list" }),
			ignore: Type.Optional(Type.Array(Type.String({ description: "Exact entry name to ignore" }))),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult(await listDirectory(ctx.cwd, params.dir_path, params.ignore ?? []));
		},
	});

	pi.registerTool({
		name: "glob",
		label: "Glob",
		description: "Find files by glob pattern.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern" }),
			dir_path: Type.Optional(Type.String({ description: "Directory to search from" })),
			case_sensitive: Type.Optional(Type.Boolean({ description: "Accepted for Gemini compatibility" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return textResult((await globFiles(ctx.cwd, params.pattern, params.dir_path)).join("\n") || "No files found");
		},
	});

	const registerGrepAlias = (name: "grep_search" | "search_file_content") => {
		pi.registerTool({
			name,
			label: name === "grep_search" ? "Grep Search" : "Search File Content",
			description: "Search file contents with ripgrep.",
			parameters: Type.Object({
				pattern: Type.String({ description: "Regex pattern" }),
				dir_path: Type.Optional(Type.String({ description: "Directory or file to search" })),
				include: Type.Optional(Type.String({ description: "Glob include filter" })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return grepFiles({ pi, ctx, pattern: params.pattern, dirPath: params.dir_path, include: params.include, signal });
			},
		});
	};
	registerGrepAlias("grep_search");
	registerGrepAlias("search_file_content");

	pi.registerTool({
		name: "replace",
		label: "Replace",
		description: "Replace exact text in a file. expected_replacements controls single vs multiple replacement.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to edit" }),
			old_string: Type.String({ description: "Exact text to replace" }),
			new_string: Type.String({ description: "Replacement text" }),
			expected_replacements: Type.Optional(Type.Number({ description: "Expected number of replacements" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await editTextFile({
				cwd: ctx.cwd,
				filePath: params.file_path,
				oldString: params.old_string,
				newString: params.new_string,
				expectedReplacements: params.expected_replacements,
				replaceAll: (params.expected_replacements ?? 1) > 1,
			});
			return textResult(`Applied ${result.replacements} replacement(s) to ${params.file_path}`, result);
		},
	});

	pi.registerTool({
		name: "write_file",
		label: "Write File",
		description: "Create or overwrite a file.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path to write" }),
			content: Type.String({ description: "Complete file content" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = await writeTextFile(ctx.cwd, params.file_path, params.content);
			return textResult(`Wrote ${params.content.length} bytes to ${params.file_path}`, { path });
		},
	});
}

