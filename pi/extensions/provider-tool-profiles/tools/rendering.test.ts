import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { renderPreviewResult, renderShellCall } from "./rendering";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const ansiTheme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function expectRenderedLinesFit(component: { render(width: number): string[] }, width: number): string[] {
	const lines = component.render(width);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	return lines;
}

describe("provider tool rendering", () => {
	it("truncates wide-character tool call lines to the render width", () => {
		const component = renderShellCall({ command: "界".repeat(20) }, plainTheme, {});
		const lines = expectRenderedLinesFit(component, 10);

		expect(lines[0]).toContain("…");
	});

	it("truncates ANSI-styled result lines using terminal visible width", () => {
		const component = renderPreviewResult(
			{ content: [{ type: "text", text: "\tXX" }], details: {} },
			{ expanded: true },
			ansiTheme,
			{ showImages: true },
			4,
		);

		expectRenderedLinesFit(component, 4);
	});

	it("keeps the tab-prefixed code preview from the pi crash within 95 columns", () => {
		const crashLine = "\tif (context.isError) return resultBlock(error(theme, textFromResult(result, context.showImages).trim()), context);";
		const component = renderPreviewResult(
			{ content: [{ type: "text", text: crashLine }], details: {} },
			{ expanded: true },
			ansiTheme,
			{ showImages: true },
			4,
		);

		expectRenderedLinesFit(component, 95);
	});
});
