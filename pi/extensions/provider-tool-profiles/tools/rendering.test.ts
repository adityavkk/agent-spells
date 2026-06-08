import { describe, expect, it } from "bun:test";
import { visibleWidth } from "./pi-compat";
import { registerClaudeTools } from "./claude";
import { registerCodexTools } from "./codex";
import { registerGeminiTools } from "./gemini";
import { renderPreviewResult, renderShellCall } from "./rendering";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const ansiTheme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const UNSAFE_CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const WIDTHS = [1, 2, 3, 4, 8, 10, 20, 40, 95];
const HOSTILE = `alpha\t${"界".repeat(24)}\x1b[31mRED\x1b[0m\x1b[2J\x1b]8;;https://bad.example\x07link\x1b]8;;\x07\x1b_bad\x07\x07\x9b\r${"tail".repeat(24)}`;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function expectRenderedLinesFit(component: { render(width: number): string[] }, width: number): string[] {
	const lines = component.render(width);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	return lines;
}

function expectTerminalSafe(lines: string[], _allowThemeAnsi = false): void {
	for (const line of lines) {
		expect(line).not.toContain("\x1b[31m");
		expect(line).not.toContain("\x1b[2J");
		expect(line).not.toContain("\x1b]8");
		expect(line).not.toContain("\x1b_");
		expect(stripAnsi(line)).not.toMatch(UNSAFE_CONTROL_PATTERN);
	}
}

function collectTools(): Map<string, any> {
	const tools = new Map<string, any>();
	const pi = { registerTool(tool: any) { tools.set(tool.name, tool); } } as any;
	registerClaudeTools(pi);
	registerCodexTools(pi);
	registerGeminiTools(pi);
	return tools;
}

function argsForTool(name: string): Record<string, unknown> {
	const path = `./${HOSTILE}/file.ts`;
	switch (name) {
		case "Read":
			return { file_path: path, offset: HOSTILE, limit: HOSTILE };
		case "Write":
			return { file_path: path, content: `first\n${HOSTILE}\n${"界".repeat(80)}` };
		case "Edit":
			return { file_path: path, old_string: HOSTILE, new_string: `${HOSTILE} new`, replace_all: false };
		case "MultiEdit":
			return { file_path: path, edits: [{ old_string: HOSTILE, new_string: `${HOSTILE} one` }, { old_string: "two", new_string: HOSTILE }] };
		case "Bash":
			return { command: `printf ${HOSTILE}`, timeout: HOSTILE, workdir: path };
		case "Glob":
			return { pattern: `**/${HOSTILE}/*.ts`, path };
		case "Grep":
			return { pattern: HOSTILE, path, glob: `**/${HOSTILE}/*.ts` };
		case "LS":
			return { path, ignore: [HOSTILE] };
		case "shell_command":
			return { command: `printf ${HOSTILE}`, timeout_ms: HOSTILE, workdir: path };
		case "apply_patch":
			return { input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${HOSTILE}\n+new\n*** End Patch` };
		case "update_plan":
			return { explanation: HOSTILE, plan: [{ status: "in_progress", step: HOSTILE }, { status: "pending", step: `${HOSTILE} later` }] };
		case "view_image":
			return { path: `./${HOSTILE}.png` };
		case "run_shell_command":
			return { command: `printf ${HOSTILE}`, dir_path: path };
		case "read_file":
			return { file_path: path, offset: HOSTILE, limit: HOSTILE };
		case "read_many_files":
			return { include: [`**/${HOSTILE}/*.ts`, `**/${HOSTILE}/*.md`], exclude: [HOSTILE] };
		case "list_directory":
			return { dir_path: path, ignore: [HOSTILE] };
		case "glob":
			return { pattern: `**/${HOSTILE}/*.ts`, dir_path: path };
		case "grep_search":
		case "search_file_content":
			return { pattern: HOSTILE, dir_path: path, include: `**/${HOSTILE}/*.ts` };
		case "replace":
			return { file_path: path, old_string: HOSTILE, new_string: `${HOSTILE} new`, expected_replacements: 1 };
		case "write_file":
			return { file_path: path, content: `first\n${HOSTILE}\n${"界".repeat(80)}` };
		default:
			throw new Error(`missing tool fixture for ${name}`);
	}
}

function resultForTool(name: string): { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> } {
	const text = name === "update_plan"
		? `- [completed] ${HOSTILE}\n- [in_progress] ${"界".repeat(90)}\n- [pending] ${HOSTILE}`
		: `first\n${HOSTILE}\n${"界".repeat(90)}`;
	return {
		content: [{ type: "text", text }],
		details: {
			path: `/tmp/${HOSTILE}/file.ts`,
			mediaType: `image/png${HOSTILE}`,
			bytes: 123456,
			lineCount: 3,
			truncated: true,
			timedOut: true,
			aborted: true,
			killed: true,
			code: 1,
			replacements: [1, 2],
			plan: [{ status: "completed", step: HOSTILE }],
		},
	};
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

	it("keeps every provider tool renderCall and renderResult inside narrow terminal widths", () => {
		for (const [name, tool] of collectTools()) {
			const args = argsForTool(name);
			const result = resultForTool(name);
			const components = [
				tool.renderCall(args, ansiTheme, { cwd: "/tmp", expanded: true, showImages: false }),
				tool.renderCall(args, ansiTheme, { cwd: "/tmp", expanded: false, showImages: false }),
				tool.renderResult(result, { expanded: true, isPartial: false }, ansiTheme, { cwd: "/tmp", expanded: true, showImages: false }),
				tool.renderResult(result, { expanded: false, isPartial: false }, ansiTheme, { cwd: "/tmp", expanded: false, showImages: false }),
				tool.renderResult(result, { expanded: false, isPartial: true }, ansiTheme, { cwd: "/tmp", expanded: false, showImages: false }),
				tool.renderResult(result, { expanded: true, isPartial: false }, ansiTheme, { cwd: "/tmp", expanded: true, showImages: false, isError: true }),
			];

			for (const component of components) {
				for (const width of WIDTHS) {
					const lines = expectRenderedLinesFit(component, width);
					expectTerminalSafe(lines, true);
				}
			}
		}
	});

	it("strips raw terminal control sequences from provider tool displays", () => {
		for (const [name, tool] of collectTools()) {
			const args = argsForTool(name);
			const result = resultForTool(name);
			const components = [
				tool.renderCall(args, plainTheme, { cwd: "/tmp", expanded: true, showImages: false }),
				tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, { cwd: "/tmp", expanded: true, showImages: false }),
				tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, { cwd: "/tmp", expanded: true, showImages: false, isError: true }),
			];

			for (const component of components) {
				const lines = expectRenderedLinesFit(component, 95);
				expectTerminalSafe(lines, false);
			}
		}
	});

	it("surfaces capped search/list metadata in preview results", () => {
		const component = renderPreviewResult(
			{ content: [{ type: "text", text: "a.ts" }], details: { capped: true, geminiIgnoreDiscoveryTruncated: true } },
			{ expanded: false },
			plainTheme,
			{ showImages: true },
		);

		expect(component.render(120).join("\n")).toContain("[capped, ignore discovery truncated]");
	});

	it("does not throw when pi renders partial or missing tool call arguments", () => {
		for (const [name, tool] of collectTools()) {
			for (const args of [undefined, {}]) {
				const component = tool.renderCall(args, ansiTheme, { cwd: "/tmp", expanded: true, showImages: false });
				for (const width of WIDTHS) {
					const lines = expectRenderedLinesFit(component, width);
					expectTerminalSafe(lines, true);
				}
			}
		}
	});
});
