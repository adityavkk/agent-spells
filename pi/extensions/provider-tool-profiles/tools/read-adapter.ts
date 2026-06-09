import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ProviderProfile } from "./policies";
import { policyForProfile, type ReadTextFormat } from "./policies";
import type { ReadHistory } from "./read-history";
import { textResult, truncateTextHead, unsupportedMediaResult, unsupportedResult, type ProviderToolResult, type TextResultDetails } from "./results";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const DEFERRED_MEDIA: Record<string, string> = {
	".aac": "audio",
	".aiff": "audio",
	".flac": "audio",
	".ipynb": "notebook",
	".m4a": "audio",
	".mp3": "audio",
	".ogg": "audio",
	".pdf": "PDF",
	".wav": "audio",
};

export interface ReadProviderFileInput {
	path: string;
	profile: Extract<ProviderProfile, "claude" | "gemini">;
	toolName: string;
	offset?: number;
	limit?: number;
	readHistory?: ReadHistory;
}

export interface ReadProviderImageInput {
	path: string;
	profile: ProviderProfile;
	toolName: string;
	readHistory?: ReadHistory;
}

export interface ReadTextDetails extends TextResultDetails {
	path: string;
	profile: "claude" | "gemini";
	toolName: string;
	lineCount: number;
	bytes: number;
	truncated: boolean;
	offset?: number;
	limit?: number;
	offsetBase: 0 | 1;
	textFormat: ReadTextFormat;
	moreAvailable: boolean;
	mediaKind: "text";
}

function splitTextLines(text: string): string[] {
	if (text.length === 0) return [];
	const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
	return withoutFinalNewline.length === 0 ? [""] : withoutFinalNewline.split("\n");
}

function normalizedOffset(offset: number | undefined, offsetBase: 0 | 1): number {
	if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.floor(offset) - offsetBase);
}

function normalizedLimit(limit: number | undefined): number | undefined {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return undefined;
	return Math.max(0, Math.floor(limit));
}

function formatCatNumberedLines(lines: readonly string[], startIndex: number): string {
	return lines.map((line, index) => `${String(startIndex + index + 1).padStart(6, " ")}\t${line}`).join("\n");
}

function formatText(lines: readonly string[], startIndex: number, format: ReadTextFormat): string {
	return format === "cat-n" ? formatCatNumberedLines(lines, startIndex) : lines.join("\n");
}

function hasNulByte(bytes: Buffer): boolean {
	return bytes.includes(0);
}

function continuationNotice(start: number, end: number, total: number, nextOffset: number): string {
	return `[Showing lines ${start + 1}-${end} of ${total}. Use offset ${nextOffset} to continue.]`;
}

async function readImage(path: string, profile: ProviderProfile, toolName: string, mimeType: string, readHistory?: ReadHistory): Promise<ProviderToolResult> {
	const [data, stats] = await Promise.all([readFile(path, "base64"), stat(path)]);
	await readHistory?.recordRead({ path, profile, toolName, kind: "image" });
	return {
		content: [
			{ type: "text", text: `Loaded image ${path}` },
			{ type: "image", data, mimeType },
		],
		details: { path, profile, toolName, bytes: stats.size, mediaKind: "image", mimeType },
	};
}

async function readText(input: ReadProviderFileInput): Promise<ProviderToolResult> {
	const policy = policyForProfile(input.profile).read;
	const bytes = await readFile(input.path);
	if (hasNulByte(bytes)) return unsupportedResult(`Unsupported media type for ${input.path}: binary file support is deferred. Use shell tools or convert the file to text/image first.`, { path: input.path, mediaKind: "binary" });

	const text = bytes.toString("utf8");
	const lines = splitTextLines(text);
	const start = normalizedOffset(input.offset, policy.offsetBase);
	const limit = normalizedLimit(input.limit);
	const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
	const selectedLines = lines.slice(start, end);
	const nextOffset = end + policy.offsetBase;
	const moreAvailable = end < lines.length;
	const formatted = formatText(selectedLines, start, policy.textFormat);
	const truncated = truncateTextHead(formatted, {
		maxLines: policy.maxLines,
		maxBytes: policy.maxBytes,
		continuationHint: moreAvailable ? `Use offset ${nextOffset} to continue.` : undefined,
	});
	const output = !truncated.truncated && moreAvailable
		? [truncated.text, continuationNotice(start, end, lines.length, nextOffset)].filter(Boolean).join("\n\n")
		: truncated.text;

	await input.readHistory?.recordRead({
		path: input.path,
		profile: input.profile,
		toolName: input.toolName,
		kind: "text",
		fileLines: lines.length,
		range: { start, end },
	});

	return textResult(output, {
		path: input.path,
		profile: input.profile,
		toolName: input.toolName,
		lineCount: lines.length,
		bytes: bytes.byteLength,
		truncated: truncated.truncated,
		offset: input.offset,
		limit: input.limit,
		offsetBase: policy.offsetBase,
		textFormat: policy.textFormat,
		moreAvailable,
		mediaKind: "text",
	});
}

export async function readProviderFile(input: ReadProviderFileInput): Promise<ProviderToolResult> {
	const extension = extname(input.path).toLowerCase();
	const imageMimeType = IMAGE_MIME_TYPES[extension];
	if (imageMimeType) return readImage(input.path, input.profile, input.toolName, imageMimeType, input.readHistory);

	const deferredKind = DEFERRED_MEDIA[extension];
	if (deferredKind) return unsupportedMediaResult(input.path, deferredKind);

	return readText(input);
}

export async function readProviderImage(input: ReadProviderImageInput): Promise<ProviderToolResult> {
	const mimeType = imageMimeTypeForPath(input.path);
	if (!mimeType) return unsupportedResult(`Unsupported image type for ${input.path}`, { path: input.path, profile: input.profile, toolName: input.toolName, unsupported: true });
	return readImage(input.path, input.profile, input.toolName, mimeType, input.readHistory);
}

export function imageMimeTypeForPath(path: string): string | undefined {
	return IMAGE_MIME_TYPES[extname(path).toLowerCase()];
}
