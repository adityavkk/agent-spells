import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat";

export const MAX_BYTES = 50 * 1024;
export const MAX_LINES = 2000;
const MAX_TIMEOUT_MS = 600_000;

export interface TextResultDetails {
	path?: string;
	truncated?: boolean;
	lineCount?: number;
	bytes?: number;
	[key: string]: unknown;
}

export interface ToolTextResult {
	content: Array<{ type: "text"; text: string }>;
	details?: TextResultDetails;
}

export interface ExactEdit {
	old_string: string;
	new_string: string;
	replace_all?: boolean;
	expected_replacements?: number;
}

const fileQueues = new Map<string, Promise<unknown>>();

export function textResult(text: string, details: TextResultDetails = {}): ToolTextResult {
	return { content: [{ type: "text", text }], details };
}

export function resolveToolPath(cwd: string, input: string): string {
	let path = input.trim().replace(/^@/, "");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

export async function withPathQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const previous = fileQueues.get(path) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(fn);
	fileQueues.set(path, run.catch(() => undefined));
	try {
		return await run;
	} finally {
		if (fileQueues.get(path) === run) fileQueues.delete(path);
	}
}

export function truncateHead(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean; lineCount: number; bytes: number } {
	const lines = text.split("\n");
	let selected = lines.slice(0, maxLines).join("\n");
	let truncated = lines.length > maxLines;
	if (Buffer.byteLength(selected, "utf8") > maxBytes) {
		selected = selected.slice(0, maxBytes);
		truncated = true;
	}
	return {
		text: truncated ? `${selected}\n\n[Output truncated to ${maxLines} lines or ${maxBytes} bytes]` : selected,
		truncated,
		lineCount: lines.length,
		bytes: Buffer.byteLength(text, "utf8"),
	};
}

export function truncateTail(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean; lineCount: number; bytes: number } {
	const lines = text.split("\n");
	let selected = lines.slice(-maxLines).join("\n");
	let truncated = lines.length > maxLines;
	if (Buffer.byteLength(selected, "utf8") > maxBytes) {
		selected = selected.slice(Math.max(0, selected.length - maxBytes));
		truncated = true;
	}
	return {
		text: truncated ? `[Output truncated to last ${maxLines} lines or ${maxBytes} bytes]\n\n${selected}` : selected,
		truncated,
		lineCount: lines.length,
		bytes: Buffer.byteLength(text, "utf8"),
	};
}

export async function readTextFile(path: string, options: { offset?: number; limit?: number; offsetBase?: 0 | 1 } = {}): Promise<ToolTextResult> {
	const content = await readFile(path, "utf8");
	const lines = content.split("\n");
	const offsetBase = options.offsetBase ?? 1;
	const start = typeof options.offset === "number" ? Math.max(0, Math.floor(options.offset) - offsetBase) : 0;
	const end = typeof options.limit === "number" ? start + Math.max(0, Math.floor(options.limit)) : lines.length;
	const selected = lines.slice(start, end).join("\n");
	const truncated = truncateHead(selected);
	return textResult(truncated.text, {
		path,
		lineCount: lines.length,
		bytes: Buffer.byteLength(content, "utf8"),
		truncated: truncated.truncated || end < lines.length,
		offset: options.offset,
		limit: options.limit,
	});
}

export async function writeTextFile(path: string, content: string): Promise<ToolTextResult> {
	return withPathQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
		return textResult(`Wrote ${path}`, { path, bytes: Buffer.byteLength(content, "utf8") });
	});
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

export async function applyExactEdits(path: string, edits: ExactEdit[]): Promise<ToolTextResult> {
	return withPathQueue(path, async () => {
		const current = await readFile(path, "utf8");
		const { text, replacements } = applyExactEditsToText(current, edits);
		await writeFile(path, text, "utf8");
		const total = replacements.reduce((sum, count) => sum + count, 0);
		return textResult(`Applied ${total} replacement(s) to ${path}`, { path, replacements, bytes: Buffer.byteLength(text, "utf8") });
	});
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

export interface RunShellInput {
	pi: Pick<ExtensionAPI, "exec">;
	ctx: Pick<ExtensionContext, "cwd">;
	command: string;
	workdir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function runShell(input: RunShellInput): Promise<ToolTextResult> {
	const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 1), MAX_TIMEOUT_MS);
	const cwd = input.workdir ? resolveToolPath(input.ctx.cwd, input.workdir) : input.ctx.cwd;
	let timedOut = false;
	let aborted = input.signal?.aborted ?? false;
	const onAbort = () => { aborted = true; };
	input.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
	timer.unref();
	try {
		const result = await input.pi.exec("bash", ["-lc", input.command], { cwd, timeout: timeoutMs, signal: input.signal });
		const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
		const exit = `(exit ${result.code ?? "unknown"})`;
		const combined = output ? `${output}${output.endsWith("\n") ? "" : "\n"}${exit}` : exit;
		const truncated = truncateTail(combined);
		return textResult(truncated.text, {
			code: result.code,
			timedOut: result.killed && timedOut,
			aborted: aborted || (result.killed && input.signal?.aborted),
			killed: result.killed,
			truncated: truncated.truncated,
		});
	} catch (error) {
		if (!aborted && !input.signal?.aborted) throw error;
		return textResult("Command aborted", { code: null, timedOut: false, aborted: true, killed: true, truncated: false });
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

function ignored(name: string, patterns: readonly string[] | undefined): boolean {
	return !!patterns?.some((pattern) => globToRegExp(pattern).test(name) || name.includes(pattern));
}

export async function listDirectory(path: string, ignore?: string[]): Promise<ToolTextResult> {
	const entries = await readdir(path, { withFileTypes: true });
	const rows = entries
		.filter((entry) => !ignored(entry.name, ignore))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
		.join("\n");
	const truncated = truncateHead(rows);
	return textResult(truncated.text || "(empty)", { path, entries: entries.length, truncated: truncated.truncated });
}

export async function globFiles(cwd: string, pattern: string, options: { dir?: string; caseSensitive?: boolean; respectGitIgnore?: boolean; exclude?: string[] } = {}): Promise<ToolTextResult> {
	const dir = options.dir ? resolveToolPath(cwd, options.dir) : cwd;
	const args = ["--files", "-g", pattern];
	for (const exclude of options.exclude ?? []) args.push("-g", `!${exclude}`);
	if (options.respectGitIgnore === false) args.push("--no-ignore");
	const result = await runProcess("rg", args, { cwd: dir, timeoutMs: 60_000 });
	if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `rg exited ${result.code}`);
	let output = result.stdout;
	if (options.caseSensitive === false) {
		const re = globToRegExp(pattern.toLowerCase());
		output = output.split("\n").filter((line) => re.test(line.toLowerCase())).join("\n");
	}
	const truncated = truncateHead(output.trim());
	return textResult(truncated.text || "No files found", { path: dir, pattern, truncated: truncated.truncated });
}

export async function grepFiles(cwd: string, input: {
	pattern: string;
	path?: string;
	glob?: string;
	output_mode?: string;
	context?: number;
	before?: number;
	after?: number;
	lineNumbers?: boolean;
	caseInsensitive?: boolean;
	type?: string;
	headLimit?: number;
	offset?: number;
	multiline?: boolean;
}): Promise<ToolTextResult> {
	const searchPath = input.path ? resolveToolPath(cwd, input.path) : cwd;
	const cwdForRg = (await stat(searchPath)).isDirectory() ? searchPath : dirname(searchPath);
	const target = (await stat(searchPath)).isDirectory() ? "." : searchPath;
	const mode = input.output_mode ?? "files_with_matches";
	const args = ["--color=never"];
	if (mode === "files_with_matches") args.push("--files-with-matches");
	else if (mode === "count") args.push("--count");
	else if (input.lineNumbers !== false) args.push("--line-number");
	if (input.glob) args.push("--glob", input.glob);
	if (input.context) args.push("-C", String(input.context));
	if (input.before) args.push("-B", String(input.before));
	if (input.after) args.push("-A", String(input.after));
	if (input.caseInsensitive) args.push("-i");
	if (input.type) args.push("--type", input.type);
	if (input.multiline) args.push("-U", "--multiline-dotall");
	args.push("--", input.pattern, target);
	const result = await runProcess("rg", args, { cwd: cwdForRg, timeoutMs: 60_000 });
	if (result.code === 1) return textResult("No matches found", { path: searchPath, pattern: input.pattern, matches: 0 });
	if (result.code !== 0) throw new Error(result.stderr || `rg exited ${result.code}`);
	let lines = result.stdout.trimEnd().split("\n");
	if (typeof input.offset === "number" && input.offset > 0) lines = lines.slice(input.offset);
	if (typeof input.headLimit === "number" && input.headLimit > 0) lines = lines.slice(0, input.headLimit);
	const output = lines.join("\n");
	const truncated = truncateHead(output);
	return textResult(truncated.text || "No matches found", { path: searchPath, pattern: input.pattern, matches: lines.length, truncated: truncated.truncated });
}
