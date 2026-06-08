import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, parseKey, Key } from "@mariozechner/pi-tui";
import { runModelSwitcher, runThinkingPicker } from "./model-switcher.js";
import { runFavouriteModels } from "./favourite-models.js";
import { OverlayFrame } from "./overlay.js";
import { copyToClipboard } from "./clipboard.js";
import type { ActionItem, ActionGroup, TopLevelEntry } from "./types.js";
import { buildSessionEntries } from "./session-actions.js";
import { buildLabelEntries } from "./label-actions.js";
import { registerBridgeCommands } from "./context-helpers.js";

function submitSlashCommand(ctx: ExtensionContext, command: string) {
	ctx.ui.setEditorText(command);
	setTimeout(() => process.stdin.emit("data", "\r"), 0);
}

function buildEntries(pi: ExtensionAPI): TopLevelEntry[] {
	const entries: TopLevelEntry[] = [];
	entries.push(buildSessionEntries(pi));
	entries.push(buildLabelEntries(pi));
	entries.push({
		type: "action",
		key: "m",
		label: "Model",
		description: "search provider -> model -> thinking",
		action: (ctx) => runModelSwitcher(pi, ctx),
	});
	entries.push({
		type: "action",
		key: "f",
		label: "Favourites",
		description: "quick-switch favourite models",
		action: (ctx) => runFavouriteModels(pi, ctx),
	});
	entries.push({
		type: "action",
		key: "t",
		label: "Thinking",
		description: "change thinking level",
		action: (ctx) => runThinkingPicker(pi, ctx),
	});

	const commands = pi.getCommands();
	const extCommands = commands.filter((c) => c.source === "extension");
	const builtinCommandNames = new Set([
		"new", "resume", "tree", "fork", "compact",
		"model", "thinking", "tools", "reload",
		"switch", "lk", "leader-key-standalone",
		"lk-switch-tree", "lk-switch-session",
	]);
	const customCommands = extCommands.filter((c) => !builtinCommandNames.has(c.name));
	if (customCommands.length > 0) {
		entries.push({
			type: "action",
			key: "e",
			label: "Extensions",
			description: `${customCommands.length} command${customCommands.length !== 1 ? "s" : ""}`,
			action: async (ctx) => {
				const items = customCommands.map((cmd) => ({
					value: cmd.name,
					label: cmd.name,
					description: cmd.description || "extension",
				}));
				const { searchableSelect } = await import("./model-switcher.js");
				const selected = await searchableSelect<string>(ctx, "Select Extension Command", items);
				if (selected) pi.sendUserMessage(`/${selected}`);
			},
		});
	}

	const skillCommands = commands.filter((c) => c.source === "skill");
	if (skillCommands.length > 0) {
		entries.push({
			type: "action",
			key: "k",
			label: "Skills",
			description: `${skillCommands.length} skill${skillCommands.length !== 1 ? "s" : ""}`,
			action: async (ctx) => {
				const items = skillCommands.map((cmd) => ({
					value: cmd.name,
					label: cmd.name,
					description: cmd.description || "skill",
				}));
				const { searchableSelect } = await import("./model-switcher.js");
				const selected = await searchableSelect<string>(ctx, "Select Skill", items);
				if (selected) {
					ctx.ui.setEditorText(`/${selected} `);
					ctx.ui.notify(`Type your prompt after /${selected}`, "info");
				}
			},
		});
	}

	entries.push({
		type: "action",
		key: "y",
		label: "Copy last response",
		description: "copy assistant message to clipboard",
		action: (ctx: ExtensionContext) => {
			const sessionEntries = ctx.sessionManager.getEntries();
			for (let i = sessionEntries.length - 1; i >= 0; i--) {
				const e = sessionEntries[i];
				if (e.type === "message" && (e.message as any).role === "assistant") {
					const content = (e.message as any).content;
					const textParts: string[] = [];
					if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === "text" && block.text) textParts.push(block.text);
						}
					}
					const text = textParts.join("\n");
					if (!text) {
						ctx.ui.notify("Last response has no text content", "info");
						return;
					}
					if (copyToClipboard(text)) ctx.ui.notify(`Copied (${text.length} chars)`, "info");
					else ctx.ui.notify("Clipboard copy failed", "error");
					return;
				}
			}
			ctx.ui.notify("No assistant message found", "info");
		},
	});
	entries.push({
		type: "action",
		key: "r",
		label: "Reload",
		description: "reload pi resources",
		action: (ctx) => submitSlashCommand(ctx, "/reload"),
	});
	entries.push({
		type: "action",
		key: "q",
		label: "Exit",
		description: "quit pi",
		action: (ctx) => submitSlashCommand(ctx, "/quit"),
	});
	return entries;
}

type View = { type: "root" } | { type: "group"; group: ActionGroup };

class LeaderKeyOverlay {
	private view: View = { type: "root" };
	private entries: TopLevelEntry[];
	private theme: Theme;
	private done: (result: ActionItem | null) => void;
	private highlightedIndex = 0;

	constructor(entries: TopLevelEntry[], theme: Theme, done: (result: ActionItem | null) => void) {
		this.entries = entries;
		this.theme = theme;
		this.done = done;
	}

	private get currentItems(): Array<{ key: string; label: string; description?: string }> {
		if (this.view.type === "root") {
			return this.entries.map((e) => e.type === "group"
				? { key: e.group.key, label: e.group.label, description: `${e.group.items.length} action${e.group.items.length !== 1 ? "s" : ""}` }
				: { key: e.key, label: e.label, description: e.description });
		}
		return this.view.group.items;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "backspace")) {
			if (this.view.type === "group") {
				this.view = { type: "root" };
				this.highlightedIndex = 0;
			} else {
				this.done(null);
			}
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.view.type === "root") {
				const items = this.currentItems;
				if (this.highlightedIndex >= 0 && this.highlightedIndex < items.length) {
					this.handleRootSelection(items[this.highlightedIndex].key);
				}
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.highlightedIndex = Math.max(0, this.highlightedIndex - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			const items = this.currentItems;
			this.highlightedIndex = Math.min(items.length - 1, this.highlightedIndex + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const items = this.currentItems;
			if (this.highlightedIndex >= 0 && this.highlightedIndex < items.length) {
				const item = items[this.highlightedIndex];
				if (this.view.type === "root") this.handleRootSelection(item.key);
				else {
					const action = this.view.group.items.find((a) => a.key === item.key);
					if (action) this.done(action);
				}
			}
			return;
		}
		const parsed = parseKey(data);
		if (parsed && parsed.length === 1 && parsed >= "a" && parsed <= "z") {
			const key = parsed.toLowerCase();
			if (this.view.type === "root") this.handleRootSelection(key);
			else {
				const action = this.view.group.items.find((a) => a.key === key);
				if (action) this.done(action);
			}
		} else if (data.length === 1 && data >= " " && data <= "~") {
			const key = data.toLowerCase();
			if (this.view.type === "root") this.handleRootSelection(key);
			else {
				const action = this.view.group.items.find((a) => a.key === key);
				if (action) this.done(action);
			}
		}
	}

	private handleRootSelection(key: string): void {
		const entry = this.entries.find((e) => e.type === "group" ? e.group.key === key : e.key === key);
		if (!entry) return;
		if (entry.type === "group") {
			this.view = { type: "group", group: entry.group };
			this.highlightedIndex = 0;
		} else {
			this.done({ key: entry.key, label: entry.label, description: entry.description, action: entry.action });
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const f = new OverlayFrame(width, th);
		const lines: string[] = [];
		lines.push(f.top());
		if (this.view.type === "root") lines.push(f.row(th.fg("accent", th.bold("Leader Key"))));
		else lines.push(f.row(th.fg("dim", "< ") + th.fg("accent", th.bold(this.view.group.label))));
		lines.push(f.separator());
		const items = this.currentItems;
		if (items.length === 0) {
			lines.push(f.row(th.fg("muted", "  (no items)")));
		} else {
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				const isHighlighted = i === this.highlightedIndex;
				const keyBadge = th.fg("warning", th.bold(`[${item.key}]`));
				const label = isHighlighted ? th.fg("accent", th.bold(item.label)) : th.fg("text", item.label);
				let suffix = "";
				if (this.view.type === "root") {
					const entry = this.entries.find((e) => e.type === "group" ? e.group.key === item.key : e.key === item.key);
					if (entry?.type === "group") suffix = " " + th.fg("dim", ">");
				}
				let line = `${isHighlighted ? "> " : "  "}${keyBadge} ${label}${suffix}`;
				if (item.description) line += "  " + th.fg("dim", item.description);
				lines.push(f.rowTruncated(line));
			}
		}
		lines.push(f.separator());
		lines.push(f.row(th.fg("dim", this.view.type === "root" ? "← close | → open | enter/key select | esc close" : "← back | enter/key run | esc close")));
		lines.push(f.bottom());
		return lines;
	}

	invalidate(): void {}
}

export default function leaderKeyStandaloneExtension(pi: ExtensionAPI) {
	registerBridgeCommands(pi);

	async function openLeaderKey(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const entries = buildEntries(pi);
		const selected = await ctx.ui.custom<ActionItem | null>((tui, theme, _kb, done) => {
			const overlay = new LeaderKeyOverlay(entries, theme, done);
			return {
				render: (w: number) => overlay.render(w),
				invalidate: () => overlay.invalidate(),
				handleInput: (data: string) => {
					overlay.handleInput(data);
					tui.requestRender();
				},
			};
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 80,
				minWidth: 50,
				maxHeight: "80%",
			},
		});
		if (selected) {
			try {
				await selected.action(ctx);
			} catch (err) {
				ctx.ui.notify(`Action failed: ${err}`, "error");
			}
		}
	}

	pi.registerCommand("lk", {
		description: "Open Leader Key palette",
		handler: async (_args, ctx) => {
			await openLeaderKey(ctx);
		},
	});

	pi.registerShortcut(Key.ctrl("x"), {
		description: "Open Leader Key",
		handler: async (ctx) => {
			await openLeaderKey(ctx);
		},
	});
}
