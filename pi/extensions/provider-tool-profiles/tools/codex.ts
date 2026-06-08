import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "./pi-compat";
import { applyPatchParams, shellCommandParams, updatePlanParams, viewImageParams } from "./schemas";
import { applyPatch } from "./apply-patch";
import { renderImageCall, renderImageResult, renderPatchCall, renderPlanCall, renderPlanResult, renderPreviewResult, renderShellCall, renderShellResult } from "./rendering";
import { runShell, textResult } from "./shared";
import { requireResolvedPath, resolveCodexImagePath, resolveExistingDirectoryUnderCwd } from "./path";

type PlanItem = { step: string; status: string };

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

function planSummary(plan: PlanItem[]): string {
	return plan.map((item) => `- [${item.status}] ${item.step}`).join("\n");
}

async function optionalCodexWorkdir(cwd: string, rawPath: unknown): Promise<string | undefined> {
	if (rawPath === undefined) return undefined;
	if (typeof rawPath !== "string") throw new Error("workdir: expected string");
	return requireResolvedPath(await resolveExistingDirectoryUnderCwd(cwd, rawPath), "workdir").absolutePath;
}

export function registerCodexTools(pi: ExtensionAPI): void {
	let currentPlan: PlanItem[] = [];

	pi.registerTool({
		name: "shell_command",
		label: "shell_command",
		description: "Run a shell command using Codex CLI-style arguments. Output is truncated.",
		promptSnippet: "Run a shell command",
		parameters: shellCommandParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const workdir = await optionalCodexWorkdir(ctx.cwd, params.workdir);
			return runShell({ pi, ctx, command: params.command, workdir, timeoutMs: params.timeout_ms, signal });
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
			currentPlan = params.plan;
			const summary = [params.explanation, planSummary(currentPlan)].filter(Boolean).join("\n\n");
			return textResult(summary || "Plan updated", { plan: currentPlan });
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
			const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
			if (!mediaType) return textResult(`Unsupported image type for ${path}`, { path, unsupported: true });
			const data = await readFile(path, "base64");
			return {
				content: [
					{ type: "text", text: `Loaded image ${path}` },
					{ type: "image", data, mimeType: mediaType },
				] as any,
				details: { path, mediaType },
			};
		},
		renderCall(args, theme, context) {
			return renderImageCall(args ?? {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderImageResult(result, options, theme, context);
		},
	});
}
