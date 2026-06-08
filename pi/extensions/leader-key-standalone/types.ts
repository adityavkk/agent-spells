import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface ActionItem {
	key: string;
	label: string;
	description?: string;
	action: (ctx: ExtensionContext) => void | Promise<void>;
}

export interface ActionGroup {
	key: string;
	label: string;
	items: ActionItem[];
}

export type TopLevelEntry =
	| { type: "group"; group: ActionGroup }
	| { type: "action"; key: string; label: string; description?: string; action: (ctx: ExtensionContext) => void | Promise<void> };
