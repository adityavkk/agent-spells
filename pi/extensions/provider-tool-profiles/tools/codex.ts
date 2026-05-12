import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { applyPatch, readImageFile, runShell, textResult } from "./shared";

export function registerCodexTools(pi: ExtensionAPI): void {
	let plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = [];

	pi.registerTool({
		name: "shell_command",
		label: "Shell Command",
		description: "Run a shell command. Set workdir instead of using cd when possible.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			workdir: Type.Optional(Type.String({ description: "Working directory, absolute or relative to cwd" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runShell({ pi, ctx, command: params.command, workdir: params.workdir, timeoutMs: params.timeout_ms, signal });
		},
	});

	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description: "Apply a Codex-style patch beginning with *** Begin Patch and ending with *** End Patch.",
		parameters: Type.Object({
			patch: Type.String({ description: "Patch text" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const changed = await applyPatch(ctx.cwd, params.patch);
			return textResult(`Applied patch to ${changed.length} file(s):\n${changed.join("\n")}`, { changed });
		},
	});

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan",
		description: "Replace the current user-visible plan with ordered steps and statuses.",
		parameters: Type.Object({
			explanation: Type.Optional(Type.String({ description: "Short explanation for the plan update" })),
			plan: Type.Array(Type.Object({
				step: Type.String({ description: "Plan step" }),
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
				]),
			})),
		}),
		async execute(_id, params) {
			plan = params.plan;
			const lines = plan.map((item) => `- ${item.status}: ${item.step}`).join("\n");
			return textResult([params.explanation, lines].filter(Boolean).join("\n"), { plan });
		},
	});

	pi.registerTool({
		name: "view_image",
		label: "View Image",
		description: "Read an image file and return it to the model.",
		parameters: Type.Object({
			path: Type.String({ description: "Image path, absolute or relative to cwd" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return readImageFile(ctx.cwd, params.path);
		},
	});
}

