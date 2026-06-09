import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead as piTruncateHead,
	truncateTail as piTruncateTail,
	type TruncationResult,
} from "./pi-compat";

export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface TextResultDetails {
	path?: string;
	truncated?: boolean;
	lineCount?: number;
	bytes?: number;
	[key: string]: unknown;
}

export interface ToolTextResult<Details extends TextResultDetails = TextResultDetails> {
	content: Array<{ type: "text"; text: string }>;
	details?: Details;
}

export interface ProviderToolResult<Details extends TextResultDetails = TextResultDetails> {
	content: ToolContent[];
	details?: Details;
	terminate?: boolean;
}

export interface AppliedTruncation {
	text: string;
	truncated: boolean;
	truncation: TruncationResult;
}

export function textResult<Details extends TextResultDetails>(text: string, details: Details): ToolTextResult<Details>;
export function textResult(text: string, details?: TextResultDetails): ToolTextResult;
export function textResult(text: string, details: TextResultDetails = {}): ToolTextResult {
	return { content: [{ type: "text", text }], details };
}

export function unsupportedResult(message: string, details: TextResultDetails = {}): ToolTextResult {
	return textResult(message, { ...details, unsupported: true });
}

export function unsupportedMediaResult(path: string, mediaKind: string): ToolTextResult {
	return unsupportedResult(
		`Unsupported media type for ${path}: ${mediaKind} support is deferred. Use shell tools or convert the file to text/image first.`,
		{ path, mediaKind },
	);
}

export function truncationNotice(result: TruncationResult, continuationHint?: string): string {
	const limit = result.truncatedBy === "lines"
		? `${result.maxLines} lines`
		: result.truncatedBy === "bytes"
			? formatSize(result.maxBytes)
			: `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}`;
	const totals = `${result.totalLines} lines, ${formatSize(result.totalBytes)}`;
	return `[Output truncated to ${limit}; original was ${totals}.${continuationHint ? ` ${continuationHint}` : ""}]`;
}

export function truncateTextHead(text: string, options: { maxLines?: number; maxBytes?: number; continuationHint?: string } = {}): AppliedTruncation {
	const truncation = piTruncateHead(text, { maxLines: options.maxLines, maxBytes: options.maxBytes });
	if (!truncation.truncated) return { text: truncation.content, truncated: false, truncation };
	const notice = truncationNotice(truncation, options.continuationHint);
	const content = truncation.content ? `${truncation.content}\n\n${notice}` : notice;
	return { text: content, truncated: true, truncation };
}

export function truncateTextTail(text: string, options: { maxLines?: number; maxBytes?: number; continuationHint?: string } = {}): AppliedTruncation {
	const truncation = piTruncateTail(text, { maxLines: options.maxLines, maxBytes: options.maxBytes });
	if (!truncation.truncated) return { text: truncation.content, truncated: false, truncation };
	const notice = truncationNotice(truncation, options.continuationHint);
	const content = truncation.content ? `${notice}\n\n${truncation.content}` : notice;
	return { text: content, truncated: true, truncation };
}
