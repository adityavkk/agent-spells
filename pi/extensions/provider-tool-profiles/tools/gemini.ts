import type { ExtensionAPI } from "./pi-compat";
import { editProviderTextFile } from "./edit-adapter";
import { listProviderDirectory } from "./list-adapter";
import { GEMINI_POLICY } from "./policies";
import { readProviderFile } from "./read-adapter";
import { runProviderGlob, runProviderGrep } from "./search-adapter";
import { runProviderShell } from "./shell-adapter";
import { writeProviderTextFile } from "./write-adapter";
import { createProviderToolRuntime, type ProviderToolRuntime } from "./runtime";
import {
	geminiGlobParams,
	listDirectoryParams,
	readFileParams,
	readManyFilesParams,
	replaceParams,
	runShellCommandParams,
	searchFileContentParams,
	writeFileParams,
} from "./schemas";
import { renderEditCall, renderEditResult, renderGlobCall, renderListCall, renderPreviewResult, renderReadCall, renderReadResult, renderSearchCall, renderShellCall, renderShellResult, renderWriteCall, renderWriteResult } from "./rendering";
import { textResult } from "./shared";
import { requireResolvedPath, resolveGeminiPath } from "./path";

async function geminiPath(cwd: string, rawPath: string, label: string): Promise<string> {
	return requireResolvedPath(await resolveGeminiPath(cwd, rawPath), label).absolutePath;
}

async function readMany(cwd: string, params: { include: string[]; exclude?: string[]; useDefaultExcludes?: boolean }, runtime: ProviderToolRuntime) {
	const policy = GEMINI_POLICY.readMany;
	const defaultExcludes = params.useDefaultExcludes === false ? [] : [...policy.defaultExcludes];
	const exclude = [...defaultExcludes, ...(params.exclude ?? [])];
	const files = new Set<string>();
	for (const include of params.include) {
		const result = await runProviderGlob({ cwd, profile: "gemini", toolName: "read_many_files", pattern: include, exclude });
		const text = result.content[0]?.text ?? "";
		for (const line of text.split("\n")) {
			const file = line.trim();
			if (file && !file.startsWith("[Output truncated") && file !== "No files found") files.add(file);
			if (files.size >= policy.maxFiles) break;
		}
		if (files.size >= policy.maxFiles) break;
	}

	const sections: string[] = [];
	let totalBytes = 0;
	let cappedByBytes = false;
	for (const file of files) {
		const path = await geminiPath(cwd, file, "read_many_files path");
		const result = await readProviderFile({ path, profile: "gemini", toolName: "read_many_files", readHistory: runtime.readHistory });
		const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		const bytes = typeof result.details?.bytes === "number" ? result.details.bytes : Buffer.byteLength(text, "utf8");
		if (totalBytes + bytes > policy.maxBytes) {
			cappedByBytes = true;
			break;
		}
		totalBytes += bytes;
		sections.push(`--- ${file} ---\n${text}`);
	}
	const cappedByFiles = files.size >= policy.maxFiles;
	const notice = cappedByFiles || cappedByBytes ? `\n\n[read_many_files output capped${cappedByFiles ? ` at ${policy.maxFiles} files` : ""}${cappedByBytes ? ` at ${policy.maxBytes} bytes` : ""}]` : "";
	return textResult(`${sections.join("\n\n") || "No files found"}${notice}`, { files: [...files], bytes: totalBytes, cappedByFiles, cappedByBytes });
}

export function registerGeminiTools(pi: ExtensionAPI, runtime: ProviderToolRuntime = createProviderToolRuntime()): void {
	pi.registerTool({
		name: "run_shell_command",
		label: "run_shell_command",
		description: "Run a bash command using Gemini CLI-style arguments. Output is truncated.",
		promptSnippet: "Run a shell command",
		parameters: runShellCommandParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runProviderShell({
				pi,
				cwd: ctx.cwd,
				profile: "gemini",
				toolName: "run_shell_command",
				command: params.command,
				workdir: params.dir_path,
				signal,
			});
		},
		renderCall(args, theme, context) {
			return renderShellCall(args, theme, context, "$");
		},
		renderResult(result, options, theme, context) {
			return renderShellResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "read_file",
		label: "read_file",
		description: "Read a file using Gemini CLI-style 0-based offset arguments.",
		promptSnippet: "Read a file",
		parameters: readFileParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return readProviderFile({
				path: await geminiPath(ctx.cwd, params.file_path, "file_path"),
				profile: "gemini",
				toolName: "read_file",
				offset: params.offset,
				limit: params.limit,
				readHistory: runtime.readHistory,
			});
		},
		renderCall(args, theme, context) {
			return renderReadCall("read_file", args?.file_path, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderReadResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "read_many_files",
		label: "read_many_files",
		description: "Read many files selected by glob patterns.",
		promptSnippet: "Read multiple files selected by glob",
		parameters: readManyFilesParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return readMany(ctx.cwd, params, runtime);
		},
		renderCall(args, theme, context) {
			return renderGlobCall("read_many_files", Array.isArray(args?.include) ? args.include.join(", ") : args?.include, ".", theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 18);
		},
	});

	pi.registerTool({
		name: "list_directory",
		label: "list_directory",
		description: "List directory contents using Gemini CLI-style arguments.",
		promptSnippet: "List directory contents",
		parameters: listDirectoryParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return listProviderDirectory({
				cwd: ctx.cwd,
				profile: "gemini",
				toolName: "list_directory",
				path: params.dir_path,
				ignore: params.ignore,
				fileFilteringOptions: params.file_filtering_options,
			});
		},
		renderCall(args, theme, context) {
			return renderListCall("list_directory", args?.dir_path, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 20);
		},
	});

	pi.registerTool({
		name: "glob",
		label: "glob",
		description: "Find files by glob pattern using Gemini CLI-style arguments.",
		promptSnippet: "Find files by glob pattern",
		parameters: geminiGlobParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runProviderGlob({
				cwd: ctx.cwd,
				profile: "gemini",
				toolName: "glob",
				pattern: params.pattern,
				path: params.dir_path,
				caseSensitive: params.case_sensitive ?? false,
				respectGitIgnore: params.respect_git_ignore,
				respectGeminiIgnore: params.respect_gemini_ignore,
				signal,
			});
		},
		renderCall(args, theme, context) {
			return renderGlobCall("glob", args?.pattern, args?.dir_path, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 18);
		},
	});

	const registerSearch = (name: "grep_search" | "search_file_content") => pi.registerTool({
		name,
		label: name,
		description: "Search file contents with ripgrep using Gemini CLI-style arguments.",
		promptSnippet: "Search file contents",
		parameters: searchFileContentParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runProviderGrep({
				cwd: ctx.cwd,
				profile: "gemini",
				toolName: name,
				pattern: params.pattern,
				path: params.dir_path,
				glob: params.include,
				outputMode: "content",
				lineNumbers: true,
				signal,
			});
		},
		renderCall(args, theme, context) {
			return renderSearchCall(name, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 15);
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			return editProviderTextFile({
				path: await geminiPath(ctx.cwd, params.file_path, "file_path"),
				edits: [{ ...params, expected_replacements: params.expected_replacements ?? 1 }],
				readHistory: runtime.readHistory,
				signal,
			});
		},
		renderCall(args, theme, context) {
			return renderEditCall("replace", args?.file_path, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "write_file",
		label: "write_file",
		description: "Create or overwrite a file using Gemini CLI-style arguments.",
		promptSnippet: "Create or overwrite a file",
		parameters: writeFileParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return writeProviderTextFile({
				path: await geminiPath(ctx.cwd, params.file_path, "file_path"),
				content: params.content,
				readHistory: runtime.readHistory,
				signal,
			});
		},
		renderCall(args, theme, context) {
			return renderWriteCall("write_file", args?.file_path, args?.content, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result, options, theme, context);
		},
	});
}
