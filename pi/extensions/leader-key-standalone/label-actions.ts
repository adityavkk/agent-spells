import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SessionTreeNode } from "@mariozechner/pi-coding-agent/dist/core/session-manager.js";
import type { TopLevelEntry } from "./types.js";
import { searchableSelect } from "./model-switcher.js";
import { collectLabeledEntries, tryNavigateTree } from "./context-helpers.js";

const PRESET_LABELS = [
	{ key: "r", label: "research", description: "mark as research" },
	{ key: "p", label: "plan", description: "mark as plan" },
];

/**
 * Entry the user means when they say "label this": the nearest message entry
 * at or above the leaf. Extensions persist invisible custom entries (recap,
 * model-profiles state) that advance the leaf; labeling those would attach
 * the label to an entry the user cannot see.
 */
function resolveLabelTargetId(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message") return entry.id;
	}
	return ctx.sessionManager.getLeafId();
}

export function buildLabelEntries(pi: ExtensionAPI): TopLevelEntry {
	return {
		type: "group",
		group: {
			key: "l",
			label: "Label",
			items: [
				...PRESET_LABELS.map((preset) => ({
					key: preset.key,
					label: preset.label,
					description: preset.description,
					action: (ctx: ExtensionContext) => {
						const targetId = resolveLabelTargetId(ctx);
						if (!targetId) {
							ctx.ui.notify("No current entry to label", "error");
							return;
						}
						pi.setLabel(targetId, preset.label);
						ctx.ui.notify(`Labeled: ${preset.label}`, "info");
					},
				})),
				{
					key: "c",
					label: "Custom label",
					description: "pick existing label",
					action: async (ctx: ExtensionContext) => {
						const targetId = resolveLabelTargetId(ctx);
						if (!targetId) {
							ctx.ui.notify("No current entry to label", "error");
							return;
						}
						const allLabels = [...PRESET_LABELS.map((p) => p.label)];
						function collectExistingLabels(nodes: SessionTreeNode[]) {
							for (const node of nodes) {
								if (node.label && !allLabels.includes(node.label)) allLabels.push(node.label);
								collectExistingLabels(node.children);
							}
						}
						collectExistingLabels(ctx.sessionManager.getTree());
						const items = allLabels.map((l) => ({ value: l, label: l, description: "label" }));
						const selected = await searchableSelect<string>(ctx, "Pick or search label", items, "type to filter, enter to select");
						if (selected) {
							pi.setLabel(targetId, selected);
							ctx.ui.notify(`Labeled: ${selected}`, "info");
						}
					},
				},
				{
					key: "x",
					label: "Clear label",
					description: "pick labeled entry to clear",
					action: async (ctx: ExtensionContext) => {
						const labeled = collectLabeledEntries(ctx.sessionManager.getTree());
						if (labeled.length === 0) {
							ctx.ui.notify("No labeled entries found", "info");
							return;
						}
						const items = labeled.map((l) => ({ value: l.id, label: `[${l.label}]`, description: l.preview || l.id.slice(0, 8) }));
						const selectedId = await searchableSelect<string>(ctx, "Clear label from entry", items);
						if (selectedId) {
							pi.setLabel(selectedId, undefined);
							ctx.ui.notify("Label cleared", "info");
						}
					},
				},
				{
					key: "g",
					label: "Go to label",
					description: "jump to a labeled entry",
					action: async (ctx: ExtensionContext) => {
						const labeled = collectLabeledEntries(ctx.sessionManager.getTree());
						if (labeled.length === 0) {
							ctx.ui.notify("No labeled entries found", "info");
							return;
						}
						const items = labeled.map((l) => ({ value: l.id, label: `[${l.label}]`, description: l.preview || l.id.slice(0, 8) }));
						const selectedId = await searchableSelect<string>(ctx, "Jump to labeled entry", items);
						if (selectedId) await tryNavigateTree(ctx, selectedId);
					},
				},
			],
		},
	};
}
