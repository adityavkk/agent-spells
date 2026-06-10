/**
 * Recap widget rendering: pure line formatting plus the component factory
 * handed to ctx.ui.setWidget(RECAP_WIDGET_KEY, ..., { placement: "aboveEditor" }).
 *
 * Width-aware via pi-tui helpers so the line never wraps or tears the layout.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { RecapStyle } from "./types";

/** Theme surface the widget needs; structurally compatible with pi's Theme. */
export interface RecapThemeLike {
	fg(color: "accent" | "dim" | "muted", text: string): string;
}

const RECAP_LABEL = "✦ recap";

export interface FormatRecapLinesInput {
	text: string;
	width: number;
	maxLines: number;
	style: RecapStyle;
	/** e.g. "ctx 62%" — appended dimmed when present. */
	contextGauge?: string;
	theme?: RecapThemeLike;
}

function paint(theme: RecapThemeLike | undefined, color: "accent" | "dim" | "muted", text: string): string {
	return theme ? theme.fg(color, text) : text;
}

/** Greedy word wrap on visible width; hard-splits words longer than the width. */
function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
		const candidate = current.length > 0 ? `${current} ${word}` : word;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}
		if (current.length > 0) lines.push(current);
		if (visibleWidth(word) > width) {
			let rest = word;
			while (visibleWidth(rest) > width) {
				lines.push(truncateToWidth(rest, width, ""));
				rest = rest.slice(truncateToWidth(rest, width, "").length);
			}
			current = rest;
		} else {
			current = word;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

/**
 * Format the recap as widget lines for the given viewport width.
 *
 * "line" style: a single `✦ recap <text>` line, truncated to fit.
 * "panel" style: a dim label line followed by up to maxLines wrapped lines.
 */
export function formatRecapLines(input: FormatRecapLinesInput): string[] {
	const width = Math.max(10, input.width);
	const gauge = input.contextGauge ? ` ${input.contextGauge}` : "";
	const text = input.text.replace(/\s+/g, " ").trim();

	if (input.style === "panel") {
		const header = paint(input.theme, "accent", RECAP_LABEL) + paint(input.theme, "dim", gauge);
		const body = wrapToWidth(text, width)
			.slice(0, Math.max(1, input.maxLines))
			.map((line) => paint(input.theme, "dim", truncateToWidth(line, width)));
		return [header, ...body];
	}

	const label = `${RECAP_LABEL} `;
	const available = width - visibleWidth(label) - visibleWidth(gauge);
	const body = truncateToWidth(text, Math.max(4, available));
	return [paint(input.theme, "accent", label) + paint(input.theme, "dim", body) + paint(input.theme, "muted", gauge)];
}

/** Placeholder line shown while /recap is generating. */
export function formatGeneratingLines(width: number, theme?: RecapThemeLike): string[] {
	return formatRecapLines({ text: "generating…", width, maxLines: 1, style: "line", theme });
}

export interface RecapWidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

export interface RecapWidgetView {
	text: string;
	maxLines: number;
	style: RecapStyle;
	contextGauge?: string;
	generating?: boolean;
}

/**
 * Component factory for setWidget. Reads the current view on every render so
 * the same mounted widget can flip from "generating…" to the recap text.
 */
export function createRecapWidgetComponent(view: () => RecapWidgetView, theme: RecapThemeLike): RecapWidgetComponent {
	return {
		render(width: number): string[] {
			const current = view();
			if (current.generating) return formatGeneratingLines(width, theme);
			return formatRecapLines({
				text: current.text,
				width,
				maxLines: current.maxLines,
				style: current.style,
				contextGauge: current.contextGauge,
				theme,
			});
		},
		invalidate(): void {
			// Rendering is derived purely from view() and theme; nothing cached.
		},
	};
}

/** Format a context-usage gauge like "ctx 62%", or undefined when unknown. */
export function formatContextGauge(percent: number | null | undefined): string | undefined {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return undefined;
	return `ctx ${Math.round(percent)}%`;
}
