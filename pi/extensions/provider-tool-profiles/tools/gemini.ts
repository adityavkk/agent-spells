import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	geminiGlobParams,
	listDirectoryParams,
	readManyFilesParams,
	readParams,
	replaceParams,
	runShellCommandParams,
	searchFileContentParams,
	writeParams,
} from "./schemas";
import { applyExactEdits, globFiles, grepFiles, listDirectory, readTextFile, resolveToolPath, runShell, textResult, writeTextFile } from "./shared";

async function readMany(cwd: string, params: { include: string[]; exclude?: string[]; useDefaultExcludes?: boolean }) {
	const defaultExcludes = params.useDefaultExcludes === false ? [] : ["node_modules/**", ".git/**", "dist/**", "coverage/**"];
	const exclude = [...defaultExcludes, ...(params.exclude ?? [])];
	const files = new Set<string>();
	for (const include of params.include) {
		const result = await globFiles(cwd, include, { exclude });
		const text = result.content[0]?.text ?? "";
		for (const line of text.split("\n")) {
			const file = line.trim();
			if (file && !file.startsWith("[Output truncated") && file !== "No files found") files.add(file);
		}
	}

	const sections: string[] = [];
	for (const file of files) {
		const path = resolveToolPath(cwd, file);
		const result = await readTextFile(path, { offsetBase: 0 });
		sections.push(`--- ${file} ---\n${result.content[0]?.text ?? ""}`);
	}
	return textResult(sections.join("\n\n") || "No files found", { files: [...files] });
}

export function registerGeminiTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "run_shell_command",
		label: "run_shell_command",
		description: "Run a bash command using Gemini CLI-style arguments. Output is truncated.",
		promptSnippet: "Run a shell command",
		parameters: runShellCommandParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cwd = params.dir_path ? resolveToolPath(ctx.cwd, params.dir_path) : ctx.cwd;
			return runShell(params.command, cwd, { signal });
		},
	});

	pi.registerTool({
		name: "read_file",
		label: "read_file",
		description: "Read a file using Gemini CLI-style 0-based offset arguments.",
		promptSnippet: "Read a file",
		parameters: readParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return readTextFile(resolveToolPath(ctx.cwd, params.file_path), { offset: params.offset, limit: params.limit, offsetBase: 0 });
		},
	});

	pi.registerTool({
		name: "read_many_files",
		label: "read_many_files",
		description: "Read many files selected by glob patterns.",
		promptSnippet: "Read multiple files selected by glob",
		parameters: readManyFilesParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return readMany(ctx.cwd, params);
		},
	});

	pi.registerTool({
		name: "list_directory",
		label: "list_directory",
		description: "List directory contents using Gemini CLI-style arguments.",
		promptSnippet: "List directory contents",
		parameters: listDirectoryParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return listDirectory(resolveToolPath(ctx.cwd, params.dir_path), params.ignore);
		},
	});

	pi.registerTool({
		name: "glob",
		label: "glob",
		description: "Find files by glob pattern using Gemini CLI-style arguments.",
		promptSnippet: "Find files by glob pattern",
		parameters: geminiGlobParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return globFiles(ctx.cwd, params.pattern, {
				dir: params.dir_path,
				caseSensitive: params.case_sensitive,
				respectGitIgnore: params.respect_git_ignore,
			});
		},
	});

	const registerSearch = (name: "grep_search" | "search_file_content") => pi.registerTool({
		name,
		label: name,
		description: "Search file contents with ripgrep using Gemini CLI-style arguments.",
		promptSnippet: "Search file contents",
		parameters: searchFileContentParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return grepFiles(ctx.cwd, {
				pattern: params.pattern,
				path: params.dir_path,
				glob: params.include,
				output_mode: "content",
				lineNumbers: true,
			});
		},
	});
	registerSearch("grep_search");
	registerSearch("search_file_content");

	pi.registerTool({
		name: "replace",
		label: "replace",
		description: "Replace exact text in a file. expected_replacements defaults to 1.",
		promptSnippet: "Replace exact text in a file",
		parameters: replaceParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return applyExactEdits(resolveToolPath(ctx.cwd, params.file_path), [{ ...params, expected_replacements: params.expected_replacements ?? 1 }]);
		},
	});

	pi.registerTool({
		name: "write_file",
		label: "write_file",
		description: "Create or overwrite a file using Gemini CLI-style arguments.",
		promptSnippet: "Create or overwrite a file",
		parameters: writeParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return writeTextFile(resolveToolPath(ctx.cwd, params.file_path), params.content);
		},
	});
}
