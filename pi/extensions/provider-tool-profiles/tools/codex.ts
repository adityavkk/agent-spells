import type { ExtensionAPI } from "./pi-compat";
import { applyPatchParams, shellCommandParams, updatePlanParams, viewImageParams } from "./schemas";
import { applyPatch } from "./apply-patch";
import { renderImageCall, renderImageResult, renderPatchCall, renderPlanCall, renderPlanResult, renderPreviewResult, renderShellCall, renderShellResult } from "./rendering";
import { createCodexPlanState, type CodexPlanState } from "./plan-state";
import { readProviderImage } from "./read-adapter";
import { runProviderShell } from "./shell-adapter";
import { requireResolvedPath, resolveCodexImagePath } from "./path";

export function registerCodexTools(pi: ExtensionAPI, planState: CodexPlanState = createCodexPlanState(pi)): void {

	pi.registerTool({
		name: "shell_command",
		label: "shell_command",
		description: "Run a shell command using Codex CLI-style arguments. Output is truncated.",
		promptSnippet: "Run a shell command",
		parameters: shellCommandParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runProviderShell({
				pi,
				cwd: ctx.cwd,
				profile: "codex",
				toolName: "shell_command",
				command: params.command,
				workdir: params.workdir,
				timeoutMs: params.timeout_ms,
				signal,
				codex: {
					login: params.login,
					sandboxPermissions: params.sandbox_permissions,
					justification: params.justification,
					prefixRule: params.prefix_rule,
				},
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
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a Codex-style patch with *** Begin Patch / *** End Patch markers.",
		promptSnippet: "Apply a Codex-style patch to files",
		parameters: applyPatchParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return applyPatch(ctx.cwd, params.input);
		},
		renderCall(args, theme, context) {
			return renderPatchCall(args ?? {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPreviewResult(result, options, theme, context, 12);
		},
	});

	pi.registerTool({
		name: "update_plan",
		label: "update_plan",
		description: "Record the current plan using Codex CLI-style plan items.",
		promptSnippet: "Update the visible task plan",
		parameters: updatePlanParams,
		async execute(_id, params) {
			return planState.update(params.plan, params.explanation);
		},
		renderCall(args, theme, context) {
			return renderPlanCall(args ?? {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPlanResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "view_image",
		label: "view_image",
		description: "Load a local image file for the model.",
		promptSnippet: "View a local image file",
		parameters: viewImageParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = requireResolvedPath(resolveCodexImagePath(ctx.cwd, params.path), "path").absolutePath;
			return readProviderImage({ path, profile: "codex", toolName: "view_image" });
		},
		renderCall(args, theme, context) {
			return renderImageCall(args ?? {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderImageResult(result, options, theme, context);
		},
	});
}
