import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bashParams, editParams, globParams, grepParams, lsParams, multiEditParams, readParams, writeParams } from "./schemas";
import { renderEditCall, renderEditResult, renderGlobCall, renderListCall, renderPreviewResult, renderReadCall, renderReadResult, renderSearchCall, renderShellCall, renderShellResult, renderWriteCall, renderWriteResult } from "./rendering";
import { applyExactEdits, globFiles, grepFiles, listDirectory, readTextFile, resolveToolPath, runShell, writeTextFile } from "./shared";

export function registerClaudeTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "Read",
		label: "Read",
		description: "Read a file using Claude Code-style arguments.",
		promptSnippet: "Read a file from the local workspace",
		parameters: readParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return readTextFile(resolveToolPath(ctx.cwd, params.file_path), { offset: params.offset, limit: params.limit, offsetBase: 1 });
		},
		renderCall(args, theme, context) {
			return renderReadCall("Read", args.file_path, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderReadResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "Write",
		label: "Write",
		description: "Create or overwrite a file using Claude Code-style arguments.",
		promptSnippet: "Create or overwrite a file",
		parameters: writeParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return writeTextFile(resolveToolPath(ctx.cwd, params.file_path), params.content);
		},
		renderCall(args, theme, context) {
			return renderWriteCall("Write", args.file_path, args.content, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "Edit",
		label: "Edit",
		description: "Replace exact text in a file. Without replace_all, old_string must match exactly once.",
		promptSnippet: "Replace exact text in a file",
		parameters: editParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return applyExactEdits(resolveToolPath(ctx.cwd, params.file_path), [params]);
		},
		renderCall(args, theme, context) {
			return renderEditCall("Edit", args.file_path, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "MultiEdit",
		label: "MultiEdit",
		description: "Apply multiple exact replacements to one file sequentially and atomically.",
		promptSnippet: "Apply multiple exact edits to one file",
		parameters: multiEditParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return applyExactEdits(resolveToolPath(ctx.cwd, params.file_path), params.edits);
		},
		renderCall(args, theme, context) {
			return renderEditCall("MultiEdit", args.file_path, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "Bash",
		label: "Bash",
		description: "Run a bash command in the current workspace. Output is truncated.",
		promptSnippet: "Run a bash command",
		parameters: bashParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.run_in_background) {
				return { content: [{ type: "text", text: "run_in_background is not supported by provider-tool-profiles v1. Run a foreground command instead." }], details: { unsupported: "run_in_background" } };
			}
			return runShell({ pi, ctx, command: params.command, timeoutMs: params.timeout, signal });
		},
		renderCall(args, theme, context) {
			return renderShellCall(args, theme, context, "$");
		},
		renderResult(result, options, theme, context) {
			return renderShellResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "Glob",
		label: "Glob",
		description: "Find files by glob pattern using ripgrep file discovery.",
		promptSnippet: "Find files by glob pattern",
		parameters: globParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return globFiles(ctx.cwd, params.pattern, { dir: params.path });
		},
		renderCall(args, theme, context) {
			return renderGlobCall("Glob", args.pattern, args.path, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 18);
		},
	});

	pi.registerTool({
		name: "Grep",
		label: "Grep",
		description: "Search file contents with ripgrep using Claude Code-style arguments.",
		promptSnippet: "Search file contents",
		parameters: grepParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return grepFiles(ctx.cwd, {
				pattern: params.pattern,
				path: params.path,
				glob: params.glob,
				output_mode: params.output_mode,
				context: params.context ?? params["-C"],
				before: params["-B"],
				after: params["-A"],
				lineNumbers: params["-n"],
				caseInsensitive: params["-i"],
				type: params.type,
				headLimit: params.head_limit,
				offset: params.offset,
				multiline: params.multiline,
			});
		},
		renderCall(args, theme, context) {
			return renderSearchCall("Grep", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 15);
		},
	});

	pi.registerTool({
		name: "LS",
		label: "LS",
		description: "List directory contents.",
		promptSnippet: "List directory contents",
		parameters: lsParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return listDirectory(resolveToolPath(ctx.cwd, params.path), params.ignore);
		},
		renderCall(args, theme, context) {
			return renderListCall("LS", args.path, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 20);
		},
	});
}
