import { isAbsolute, relative } from "node:path";
import { spawn } from "node:child_process";
import { withFileMutationQueue } from "./pi-compat";
import { requireResolvedPath, resolveClaudePath } from "./path";
import { textResult, truncateTextHead, truncateTextTail, type TextResultDetails, type ToolTextResult } from "./results";

export { textResult, type TextResultDetails, type ToolTextResult } from "./results";

export const MAX_BYTES = 50 * 1024;
export const MAX_LINES = 2000;
const MAX_TIMEOUT_MS = 600_000;

export interface ExactEdit {
	old_string: string;
	new_string: string;
	replace_all?: boolean;
	expected_replacements?: number;
}

export function resolveToolPath(cwd: string, input: string): string {
	return requireResolvedPath(resolveClaudePath(cwd, input)).absolutePath;
}

export function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

export async function withPathQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
	return withFileMutationQueue(path, fn);
}

export function truncateHead(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean; lineCount: number; bytes: number } {
	const applied = truncateTextHead(text, { maxLines, maxBytes });
	return {
		text: applied.text,
		truncated: applied.truncated,
		lineCount: applied.truncation.totalLines,
		bytes: applied.truncation.totalBytes,
	};
}

export function truncateTail(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean; lineCount: number; bytes: number } {
	const applied = truncateTextTail(text, { maxLines, maxBytes });
	return {
		text: applied.text,
		truncated: applied.truncated,
		lineCount: applied.truncation.totalLines,
		bytes: applied.truncation.totalBytes,
	};
}

function countOccurrences(text: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = 0;
	while (true) {
		index = text.indexOf(needle, index);
		if (index === -1) return count;
		count += 1;
		index += needle.length;
	}
}

function replaceAllLiteral(text: string, oldText: string, newText: string): string {
	return text.split(oldText).join(newText);
}

export function applyExactEditsToText(input: string, edits: ExactEdit[]): { text: string; replacements: number[] } {
	let text = input;
	const replacements: number[] = [];
	for (const [index, edit] of edits.entries()) {
		if (edit.old_string === edit.new_string) throw new Error(`Edit ${index + 1}: old_string and new_string must differ`);
		const occurrences = countOccurrences(text, edit.old_string);
		const expected = edit.expected_replacements ?? (edit.replace_all ? occurrences : 1);
		if (occurrences !== expected && (!edit.replace_all || occurrences < expected)) {
			throw new Error(`Edit ${index + 1}: expected ${expected} replacement(s), found ${occurrences}`);
		}
		if (edit.replace_all || expected > 1) {
			text = replaceAllLiteral(text, edit.old_string, edit.new_string);
			replacements.push(occurrences);
			continue;
		}
		text = text.replace(edit.old_string, edit.new_string);
		replacements.push(1);
	}
	return { text, replacements };
}

export interface ProcessResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessResult> {
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 1), MAX_TIMEOUT_MS);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: process.env, shell: false });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let aborted = false;
		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolvePromise(result);
		};
		const kill = () => {
			try { child.kill("SIGTERM"); } catch {}
			setTimeout(() => {
				try { child.kill("SIGKILL"); } catch {}
			}, 1000).unref();
		};
		const onAbort = () => {
			aborted = true;
			kill();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		timer.unref();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", (code) => finish({ stdout, stderr, code, timedOut, aborted }));
	});
}

