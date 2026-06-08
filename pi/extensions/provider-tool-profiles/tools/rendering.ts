import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { truncateToWidth, visibleWidth } from "./pi-compat";

type ThemeLike = {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

type RenderOptionsLike = {
	expanded?: boolean;
	isPartial?: boolean;
};

type RenderContextLike = {
	args?: any;
	cwd?: string;
	expanded?: boolean;
	isError?: boolean;
	showImages?: boolean;
	lastComponent?: unknown;
};

type ToolResultLike = {
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; source?: unknown }>;
	details?: Record<string, unknown>;
};

type ComponentLike = {
	render(width: number): string[];
	invalidate(): void;
};

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const UNSAFE_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function sanitizeDisplayText(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/\r/g, "")
		.replace(/\t/g, "    ")
		.replace(UNSAFE_CONTROL_PATTERN, "");
}

function sanitizeInlineText(text: string): string {
	return sanitizeDisplayText(text).replace(/\n+/g, " ").replace(/ +/g, " ").trim();
}

function inline(value: unknown): string {
	return sanitizeInlineText(String(value));
}

function truncateLine(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
}

class TextBlock implements ComponentLike {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		return this.text.split("\n").map((line) => truncateLine(line, width));
	}

	invalidate(): void {}
}

class EmptyBlock implements ComponentLike {
	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {}
}

function textBlock(text: string, lastComponent?: unknown): ComponentLike {
	if (lastComponent instanceof TextBlock) {
		lastComponent.setText(text);
		return lastComponent;
	}
	return new TextBlock(text);
}

function emptyBlock(lastComponent?: unknown): ComponentLike {
	return lastComponent instanceof EmptyBlock ? lastComponent : new EmptyBlock();
}

function fg(theme: ThemeLike, color: string, text: string): string {
	return theme.fg?.(color, text) ?? text;
}

function bold(theme: ThemeLike, text: string): string {
	return theme.bold?.(text) ?? text;
}

function title(theme: ThemeLike, text: string): string {
	return fg(theme, "toolTitle", bold(theme, text));
}

function dim(theme: ThemeLike, text: string): string {
	return fg(theme, "dim", text);
}

function muted(theme: ThemeLike, text: string): string {
	return fg(theme, "muted", text);
}

function accent(theme: ThemeLike, text: string): string {
	return fg(theme, "accent", text);
}

function output(theme: ThemeLike, text: string): string {
	return fg(theme, "toolOutput", text);
}

function error(theme: ThemeLike, text: string): string {
	return fg(theme, "error", text);
}

function warning(theme: ThemeLike, text: string): string {
	return fg(theme, "warning", text);
}

function success(theme: ThemeLike, text: string): string {
	return fg(theme, "success", text);
}

function str(value: unknown): string | null {
	if (typeof value === "string") return sanitizeDisplayText(value);
	if (value == null) return "";
	return null;
}

function short(value: string, max = 96): string {
	const clean = sanitizeInlineText(value);
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

function stripTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end -= 1;
	return lines.slice(0, end);
}

function formatBytes(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value < 1024) return `${value}B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
	return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function displayPath(cwd: string | undefined, rawPath: string | null, emptyFallback = "."): string {
	if (rawPath === null) return "[invalid path]";
	const input = rawPath ? sanitizeInlineText(rawPath).replace(/^@/, "") : emptyFallback;
	if (!input) return emptyFallback;
	const home = homedir();
	const absolute = input === "~"
		? home
		: input.startsWith("~/")
			? resolve(home, input.slice(2))
			: isAbsolute(input)
				? input
				: undefined;
	if (absolute && cwd) {
		const rel = relative(cwd, absolute);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
		if (!rel) return ".";
	}
	if (absolute?.startsWith(home)) return `~${absolute.slice(home.length)}`;
	return input;
}

function renderPath(theme: ThemeLike, cwd: string | undefined, rawPath: unknown, emptyFallback = "."): string {
	const value = str(rawPath);
	if (value === null) return error(theme, "[invalid path]");
	return accent(theme, displayPath(cwd, value, emptyFallback));
}

function textFromResult(result: ToolResultLike, showImages = true): string {
	const text = sanitizeDisplayText((result.content ?? [])
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n"));
	const imageCount = (result.content ?? []).filter((item) => item.type === "image").length;
	if (showImages || imageCount === 0) return text;
	const suffix = `${imageCount} image${imageCount === 1 ? "" : "s"}`;
	return text ? `${text}\n[${suffix}]` : `[${suffix}]`;
}

function previewLines(text: string, options: {
	expanded?: boolean;
	maxLines: number;
	tail?: boolean;
	theme: ThemeLike;
}): string {
	const lines = stripTrailingEmptyLines(text.split("\n"));
	if (options.expanded || lines.length <= options.maxLines) return lines.join("\n");
	const omitted = lines.length - options.maxLines;
	const shown = options.tail ? lines.slice(-options.maxLines) : lines.slice(0, options.maxLines);
	const label = options.tail ? `${omitted} earlier lines` : `${omitted} more lines`;
	return [dim(options.theme, `... (${label}; expand for full output)`), ...shown].join("\n");
}

function styleOutputLines(text: string, theme: ThemeLike): string {
	return text.split("\n").map((line) => output(theme, line)).join("\n");
}

function resultBlock(text: string, context: RenderContextLike): ComponentLike {
	return text ? textBlock(`\n${text}`, context.lastComponent) : emptyBlock(context.lastComponent);
}

function detailNumber(details: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = details?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maybeStatusWarning(details: Record<string, unknown> | undefined, theme: ThemeLike): string | undefined {
	const notices: string[] = [];
	if (details?.timedOut) notices.push("timed out");
	if (details?.aborted) notices.push("aborted");
	if (details?.killed) notices.push("killed");
	if (details?.truncated) notices.push("truncated");
	if (notices.length === 0) return undefined;
	return warning(theme, `[${notices.join(", ")}]`);
}

export function renderShellCall(args: any, theme: ThemeLike, context: RenderContextLike, label = "$"): ComponentLike {
	const command = str(args?.command);
	const timeout = args?.timeout ?? args?.timeout_ms;
	let text = title(theme, `${label} `) + (command === null ? error(theme, "[invalid command]") : accent(theme, command || "..."));
	if (args?.workdir || args?.dir_path) text += muted(theme, ` in ${displayPath(context.cwd, str(args.workdir ?? args.dir_path), ".")}`);
	if (timeout !== undefined) text += muted(theme, ` (timeout ${inline(timeout)}${typeof timeout === "number" && timeout < 1000 ? "s" : "ms"})`);
	return textBlock(text, context.lastComponent);
}

export function renderShellResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const raw = textFromResult(result, context.showImages).trim();
	const rendered = raw
		? styleOutputLines(previewLines(raw, { expanded: options.expanded, maxLines: 6, tail: true, theme }), theme)
		: dim(theme, options.isPartial ? "Running..." : "(no output)");
	const status = maybeStatusWarning(result.details, theme);
	return resultBlock([rendered, status].filter(Boolean).join("\n"), context);
}

export function renderReadCall(name: string, rawPath: unknown, args: any, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	let text = `${title(theme, name)} ${renderPath(theme, context.cwd, rawPath)}`;
	const offset = args?.offset;
	const limit = args?.limit;
	if (offset !== undefined || limit !== undefined) {
		text += muted(theme, ` (${[offset !== undefined ? `offset ${inline(offset)}` : undefined, limit !== undefined ? `limit ${inline(limit)}` : undefined].filter(Boolean).join(", ")})`);
	}
	return textBlock(text, context.lastComponent);
}

export function renderReadResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const raw = textFromResult(result, context.showImages);
	if (context.isError) {
		return resultBlock(error(theme, previewLines(raw.trim(), { expanded: true, maxLines: 20, theme })), context);
	}
	if (!options.expanded) {
		const parts = [
			detailNumber(result.details, "lineCount") !== undefined ? `${detailNumber(result.details, "lineCount")} lines` : undefined,
			formatBytes(result.details?.bytes),
			result.details?.truncated ? "truncated" : undefined,
		].filter(Boolean);
		return resultBlock(dim(theme, parts.length ? `${parts.join(", ")} (expand to view)` : "read complete (expand to view)"), context);
	}
	return resultBlock(styleOutputLines(raw, theme), context);
}

export function renderWriteCall(name: string, rawPath: unknown, content: unknown, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	let text = `${title(theme, name)} ${renderPath(theme, context.cwd, rawPath)}`;
	const fileContent = str(content);
	if (fileContent === null) {
		text += `\n\n${error(theme, "[invalid content]")}`;
	} else if (fileContent) {
		const preview = previewLines(fileContent.replace(/\r/g, ""), { expanded: context.expanded, maxLines: 8, theme });
		text += `\n\n${styleOutputLines(preview, theme)}`;
	}
	return textBlock(text, context.lastComponent);
}

export function renderWriteResult(result: ToolResultLike, _options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const raw = textFromResult(result, context.showImages).trim();
	if (context.isError) return resultBlock(error(theme, raw), context);
	const bytes = formatBytes(result.details?.bytes);
	const summary = bytes ? `wrote ${bytes}` : short(raw || "write complete");
	return resultBlock(success(theme, `✓ ${summary}`), context);
}

function countEdits(args: any): number {
	if (Array.isArray(args?.edits)) return args.edits.length;
	if (typeof args?.old_string === "string" || typeof args?.oldText === "string") return 1;
	return 0;
}

function editRows(args: any): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(args?.edits)) {
		return args.edits.map((edit: any) => ({ oldText: String(edit?.old_string ?? edit?.oldText ?? ""), newText: String(edit?.new_string ?? edit?.newText ?? "") }));
	}
	return [{ oldText: String(args?.old_string ?? args?.oldText ?? ""), newText: String(args?.new_string ?? args?.newText ?? "") }];
}

export function renderEditCall(name: string, rawPath: unknown, args: any, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const edits = countEdits(args);
	let text = `${title(theme, name)} ${renderPath(theme, context.cwd, rawPath)}`;
	if (edits > 0) text += muted(theme, ` (${edits} replacement${edits === 1 ? "" : "s"})`);
	if (context.expanded) {
		const rows = editRows(args).slice(0, 6).map((row) => `${short(row.oldText, 72)} ${dim(theme, "→")} ${short(row.newText, 72)}`);
		if (rows.length) text += `\n\n${rows.map((row) => output(theme, row)).join("\n")}`;
	}
	return textBlock(text, context.lastComponent);
}

export function renderEditResult(result: ToolResultLike, _options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const raw = textFromResult(result, context.showImages).trim();
	if (context.isError) return resultBlock(error(theme, raw), context);
	const replacements = Array.isArray(result.details?.replacements)
		? result.details.replacements.reduce((sum: number, value: unknown) => sum + (typeof value === "number" ? value : 0), 0)
		: undefined;
	const summary = replacements !== undefined ? `applied ${replacements} replacement${replacements === 1 ? "" : "s"}` : short(raw || "edit complete");
	return resultBlock(success(theme, `✓ ${summary}`), context);
}

export function renderGlobCall(name: string, pattern: unknown, dir: unknown, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const patternText = str(pattern);
	let text = `${title(theme, name)} ${patternText === null ? error(theme, "[invalid pattern]") : accent(theme, patternText || "...")}`;
	text += muted(theme, ` in ${displayPath(context.cwd, str(dir), ".")}`);
	return textBlock(text, context.lastComponent);
}

export function renderSearchCall(name: string, args: any, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const pattern = str(args?.pattern);
	let text = `${title(theme, name)} ${pattern === null ? error(theme, "[invalid pattern]") : accent(theme, `/${pattern || ""}/`)}`;
	text += muted(theme, ` in ${displayPath(context.cwd, str(args?.path ?? args?.dir_path), ".")}`);
	if (args?.glob || args?.include) text += muted(theme, ` (${inline(args.glob ?? args.include)})`);
	return textBlock(text, context.lastComponent);
}

export function renderListCall(name: string, rawPath: unknown, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	return textBlock(`${title(theme, name)} ${renderPath(theme, context.cwd, rawPath, ".")}`, context.lastComponent);
}

export function renderPreviewResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike, maxLines = 16): ComponentLike {
	const raw = textFromResult(result, context.showImages).trim();
	if (context.isError) return resultBlock(error(theme, raw), context);
	const rendered = styleOutputLines(previewLines(raw, { expanded: options.expanded, maxLines, theme }), theme);
	const status = maybeStatusWarning(result.details, theme);
	return resultBlock([rendered, status].filter(Boolean).join("\n"), context);
}

function summarizePatch(input: unknown): string[] {
	const patch = str(input);
	if (!patch) return [];
	const lines: string[] = [];
	for (const line of patch.split("\n")) {
		const match = line.match(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/);
		if (!match) continue;
		const action = match[1] === "Add File" ? "add" : match[1] === "Update File" ? "update" : match[1] === "Delete File" ? "delete" : "move";
		lines.push(`${action} ${match[2]?.trim()}`);
	}
	return lines;
}

export function renderPatchCall(args: any, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const summary = summarizePatch(args?.input);
	let text = title(theme, "apply_patch");
	if (summary.length) text += muted(theme, ` ${summary.slice(0, 4).join(", ")}${summary.length > 4 ? `, +${summary.length - 4}` : ""}`);
	if (context.expanded && typeof args?.input === "string") {
		text += `\n\n${styleOutputLines(previewLines(sanitizeDisplayText(args.input), { expanded: false, maxLines: 24, theme }), theme)}`;
	}
	return textBlock(text, context.lastComponent);
}

export function renderPlanCall(args: any, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const count = Array.isArray(args?.plan) ? args.plan.length : 0;
	return textBlock(`${title(theme, "update_plan")} ${muted(theme, `${count} step${count === 1 ? "" : "s"}`)}`, context.lastComponent);
}

export function renderPlanResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	const raw = textFromResult(result, context.showImages).trim();
	const rendered = previewLines(raw, { expanded: options.expanded, maxLines: 10, theme })
		.split("\n")
		.map((line) => line.match(/^[-*] \[(completed|in_progress|pending)\]/) ? accent(theme, line) : output(theme, line))
		.join("\n");
	return resultBlock(rendered, context);
}

export function renderImageCall(args: any, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	return textBlock(`${title(theme, "view_image")} ${renderPath(theme, context.cwd, args?.path)}`, context.lastComponent);
}

export function renderImageResult(result: ToolResultLike, _options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): ComponentLike {
	if (context.isError) return resultBlock(error(theme, textFromResult(result, context.showImages).trim()), context);
	const path = typeof result.details?.path === "string" ? displayPath(context.cwd, sanitizeDisplayText(result.details.path)) : "image";
	const mediaType = typeof result.details?.mediaType === "string" ? ` ${sanitizeInlineText(result.details.mediaType)}` : "";
	return resultBlock(success(theme, `loaded ${path}${mediaType}`), context);
}
