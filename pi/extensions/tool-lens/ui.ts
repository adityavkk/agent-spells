/**
 * Thin TUI components for tool-lens. All text is produced by the pure builders
 * in `render-text.ts`; these components only add theme color and read the shared
 * store on each paint, never blocking render on the model.
 */
import { Text, type Component, type Theme } from "./pi-compat";
import { cardLines, hudCompactLine, hudLines } from "./render-text";
import type { ToolLensStore } from "./store";
import type { ToolLensRecordV1, ToolLensVisibility } from "./types";

export interface HudView {
	visibility: ToolLensVisibility;
	turnIndex: number;
	maxRows: number;
}

/** Live below-editor HUD. Reads the store + current view on each render. */
export function createHudComponent(
	store: ToolLensStore,
	getView: () => HudView,
	theme: Theme,
): Component & { dispose?(): void } {
	const component = new Text("", 0, 0);
	const repaint = (): void => {
		const view = getView();
		if (view.visibility === "hidden") {
			component.setText("");
			return;
		}
		const records = store.allSourceOrdered();
		if (view.visibility === "compact") {
			component.setText(theme.fg("dim", hudCompactLine(records)));
			return;
		}
		const lines = hudLines(records, view.turnIndex, view.maxRows);
		const [header, ...rows] = lines;
		const painted = [theme.fg("toolTitle", header ?? "tool-lens")].concat(
			rows.map((line) => theme.fg("muted", line)),
		);
		component.setText(painted.join("\n"));
	};
	repaint();
	// Expose repaint via a property so the extension can refresh on store change.
	(component as Text & { repaint?: () => void }).repaint = repaint;
	return component;
}

/** Build the styled text for a persisted card. */
export function buildCardText(
	record: ToolLensRecordV1,
	visibility: ToolLensVisibility,
	expanded: boolean,
	theme: Theme,
): string {
	const lines = cardLines(record, visibility, expanded);
	if (lines.length === 0) return "";
	const [title, ...rest] = lines;
	if (visibility === "hidden") return theme.fg("dim", title ?? "");
	const header = theme.fg("toolTitle", title ?? "lens");
	return [header, ...rest.map((line) => theme.fg("muted", line))].join("\n");
}

export function createCardComponent(
	record: ToolLensRecordV1,
	visibility: ToolLensVisibility,
	expanded: boolean,
	theme: Theme,
): Component {
	return new Text(buildCardText(record, visibility, expanded, theme), 0, 0);
}
