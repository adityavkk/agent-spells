import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { SessionTreeNode } from "@mariozechner/pi-coding-agent/dist/core/session-manager.js";

function isCommandCtx(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return "switchSession" in ctx && typeof (ctx as any).switchSession === "function";
}

function emitCommand(ctx: ExtensionContext, command: string) {
	ctx.ui.setEditorText(command);
	setTimeout(() => process.stdin.emit("data", "\r"), 0);
}

export async function tryNavigateTree(ctx: ExtensionContext, targetId: string) {
	if (isCommandCtx(ctx)) {
		await ctx.navigateTree(targetId);
	} else {
		emitCommand(ctx, `/lk-switch-tree ${targetId}`);
	}
}

export async function trySwitchSession(ctx: ExtensionContext, sessionPath: string) {
	if (isCommandCtx(ctx)) {
		await ctx.switchSession(sessionPath);
	} else {
		emitCommand(ctx, `/lk-switch-session ${sessionPath}`);
	}
}

export function registerBridgeCommands(pi: ExtensionAPI) {
	pi.registerCommand("lk-switch-tree", {
		description: "(internal) Navigate to a tree entry by ID",
		handler: async (args, ctx) => {
			const targetId = args.trim();
			if (!targetId) return;
			await ctx.navigateTree(targetId);
		},
	});

	pi.registerCommand("lk-switch-session", {
		description: "(internal) Switch to a session file by path",
		handler: async (args, ctx) => {
			const sessionPath = args.trim();
			if (!sessionPath) return;
			await ctx.switchSession(sessionPath);
		},
	});
}

export interface LabeledEntry {
	id: string;
	label: string;
	preview: string;
}

export function collectLabeledEntries(tree: SessionTreeNode[]): LabeledEntry[] {
	const labeled: LabeledEntry[] = [];

	function walk(nodes: SessionTreeNode[]) {
		for (const node of nodes) {
			if (node.label) {
				let preview = "";
				if (node.entry.type === "message") {
					const msg = node.entry.message;
					if (typeof msg.content === "string") {
						preview = msg.content.slice(0, 60);
					} else if (Array.isArray(msg.content)) {
						const text = msg.content.find((c: any) => c.type === "text");
						if (text && "text" in text) preview = (text as any).text.slice(0, 60);
					}
				}
				labeled.push({ id: node.entry.id, label: node.label, preview });
			}
			walk(node.children);
		}
	}

	walk(tree);
	return labeled;
}
