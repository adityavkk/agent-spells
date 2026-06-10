import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	createRecapWidgetComponent,
	formatContextGauge,
	formatGeneratingLines,
	formatRecapLines,
	type RecapThemeLike,
	type RecapWidgetView,
} from "./widget";

/** Theme stub that tags colors so tests can assert what got painted. */
const TAGGING_THEME: RecapThemeLike = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};

describe("formatRecapLines (line style)", () => {
	it("renders a single labeled line within the viewport width", () => {
		const lines = formatRecapLines({ text: "Migrating auth to JWT.", width: 80, maxLines: 1, style: "line" });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("✦ recap");
		expect(lines[0]).toContain("Migrating auth to JWT.");
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(80);
	});

	it("truncates long recaps instead of wrapping", () => {
		const lines = formatRecapLines({ text: "word ".repeat(100), width: 40, maxLines: 1, style: "line" });
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(40);
		expect(lines[0]).toContain("...");
	});

	it("collapses internal whitespace", () => {
		const lines = formatRecapLines({ text: "a\n\n  b\tc", width: 80, maxLines: 1, style: "line" });
		expect(lines[0]).toContain("a b c");
	});

	it("appends the context gauge when provided", () => {
		const lines = formatRecapLines({
			text: "Working.",
			width: 80,
			maxLines: 1,
			style: "line",
			contextGauge: "ctx 62%",
		});
		expect(lines[0]).toContain("ctx 62%");
	});

	it("paints label, body, and gauge with theme colors", () => {
		const lines = formatRecapLines({
			text: "Working.",
			width: 80,
			maxLines: 1,
			style: "line",
			contextGauge: "ctx 10%",
			theme: TAGGING_THEME,
		});
		expect(lines[0]).toContain("<accent>✦ recap </accent>");
		expect(lines[0]).toContain("<dim>");
		expect(lines[0]).toContain("<muted> ctx 10%</muted>");
	});
});

describe("formatRecapLines (panel style)", () => {
	it("renders a header plus wrapped body capped at maxLines", () => {
		const lines = formatRecapLines({
			text: "alpha bravo charlie delta echo foxtrot golf hotel india juliett",
			width: 20,
			maxLines: 2,
			style: "panel",
		});
		expect(lines.length).toBe(3); // header + 2 body lines
		expect(lines[0]).toContain("✦ recap");
		for (const line of lines.slice(1)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});

	it("hard-splits words wider than the viewport", () => {
		const lines = formatRecapLines({ text: "w".repeat(50), width: 20, maxLines: 3, style: "panel" });
		for (const line of lines.slice(1)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});
});

describe("formatGeneratingLines", () => {
	it("shows a placeholder line", () => {
		const lines = formatGeneratingLines(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("generating…");
	});
});

describe("createRecapWidgetComponent", () => {
	it("renders from the live view and flips from generating to text", () => {
		let view: RecapWidgetView = { text: "", maxLines: 1, style: "line", generating: true };
		const component = createRecapWidgetComponent(() => view, TAGGING_THEME);
		expect(component.render(60)[0]).toContain("generating…");

		view = { text: "Done: tests pass.", maxLines: 1, style: "line" };
		expect(component.render(60)[0]).toContain("Done: tests pass.");
		component.invalidate(); // no-op, must not throw
	});
});

describe("formatContextGauge", () => {
	it("rounds percentages", () => {
		expect(formatContextGauge(61.8)).toBe("ctx 62%");
	});

	it("returns undefined when usage is unknown", () => {
		expect(formatContextGauge(null)).toBeUndefined();
		expect(formatContextGauge(undefined)).toBeUndefined();
		expect(formatContextGauge(Number.NaN)).toBeUndefined();
	});
});
