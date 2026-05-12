import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface TextToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}

export interface ImageToolResult {
	content: Array<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}

export function textResult(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details };
}

export function resolvePath(cwd: string, filePath: string): string {
	const expanded = filePath.startsWith("~") ? path.join(process.env.HOME ?? cwd, filePath.slice(1)) : filePath;
	return path.resolve(cwd, expanded);
}

export function relativePath(cwd: string, absolutePath: string): string {
	const relative = path.relative(cwd, absolutePath);
	return relative || path.basename(absolutePath);
}

export async function readTextFile(input: {
	cwd: string;
	filePath: string;
	offset?: number;
	limit?: number;
	offsetBase?: 0 | 1;
	numberLines?: boolean;
}): Promise<string> {
	const absolutePath = resolvePath(input.cwd, input.filePath);
	const text = await readFile(absolutePath, "utf-8");
	const lines = text.split("\n");
	const offset = Math.max(0, Math.floor(input.offset ?? (input.offsetBase === 1 ? 1 : 0)) - (input.offsetBase ?? 0));
	const limit = input.limit === undefined ? undefined : Math.max(0, Math.floor(input.limit));
	const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit);
	if (!input.numberLines) return selected.join("\n");
	const width = String(offset + selected.length).length;
	return selected.map((line, index) => `${String(offset + index + 1).padStart(width, " ")}\t${line}`).join("\n");
}

export async function writeTextFile(cwd: string, filePath: string, content: string): Promise<string> {
	const absolutePath = resolvePath(cwd, filePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf-8");
	return absolutePath;
}

export function replaceExact(input: {
	content: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
	expectedReplacements?: number;
}): { content: string; replacements: number } {
	if (input.oldString.length === 0) {
		throw new Error("old_string must not be empty");
	}

	const matches = input.content.split(input.oldString).length - 1;
	const expected = input.expectedReplacements;
	if (expected !== undefined && matches !== expected) {
		throw new Error(`Expected ${expected} replacement(s), found ${matches}`);
	}
	if (matches === 0) {
		throw new Error("old_string was not found");
	}
	if (!input.replaceAll && expected === undefined && matches !== 1) {
		throw new Error(`old_string appears ${matches} times; use replace_all or expected_replacements`);
	}

	const replaceAll = input.replaceAll || (expected !== undefined && expected > 1);
	return {
		content: replaceAll
			? input.content.split(input.oldString).join(input.newString)
			: input.content.replace(input.oldString, input.newString),
		replacements: replaceAll ? matches : 1,
	};
}

export async function editTextFile(input: {
	cwd: string;
	filePath: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
	expectedReplacements?: number;
}): Promise<{ absolutePath: string; replacements: number }> {
	const absolutePath = resolvePath(input.cwd, input.filePath);
	const current = await readFile(absolutePath, "utf-8");
	const edited = replaceExact({
		content: current,
		oldString: input.oldString,
		newString: input.newString,
		replaceAll: input.replaceAll,
		expectedReplacements: input.expectedReplacements,
	});
	await writeFile(absolutePath, edited.content, "utf-8");
	return { absolutePath, replacements: edited.replacements };
}

export async function multiEditTextFile(input: {
	cwd: string;
	filePath: string;
	edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
}): Promise<{ absolutePath: string; replacements: number }> {
	const absolutePath = resolvePath(input.cwd, input.filePath);
	let content = await readFile(absolutePath, "utf-8");
	let replacements = 0;
	for (const edit of input.edits) {
		const edited = replaceExact({
			content,
			oldString: edit.old_string,
			newString: edit.new_string,
			replaceAll: edit.replace_all,
		});
		content = edited.content;
		replacements += edited.replacements;
	}
	await writeFile(absolutePath, content, "utf-8");
	return { absolutePath, replacements };
}

export async function runShell(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	command: string;
	workdir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<TextToolResult> {
	const cwd = input.workdir ? resolvePath(input.ctx.cwd, input.workdir) : input.ctx.cwd;
	const result = await input.pi.exec("bash", ["-lc", input.command], {
		cwd,
		timeout: input.timeoutMs,
		signal: input.signal,
	});
	const output = [
		result.stdout,
		result.stderr ? `stderr:\n${result.stderr}` : "",
		`exit_code: ${result.code}`,
	].filter(Boolean).join("\n");
	return textResult(output, { cwd, code: result.code, killed: result.killed });
}

export async function listDirectory(cwd: string, dirPath: string, ignore: string[] = []): Promise<string> {
	const absolutePath = resolvePath(cwd, dirPath);
	const entries = await readdir(absolutePath, { withFileTypes: true });
	const ignored = new Set(ignore);
	return entries
		.filter((entry) => !ignored.has(entry.name))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) => `${entry.isDirectory() ? "dir " : "file"}\t${entry.name}`)
		.join("\n");
}

export async function globFiles(cwd: string, pattern: string, dirPath = "."): Promise<string[]> {
	const root = resolvePath(cwd, dirPath);
	const glob = new Bun.Glob(pattern);
	const files: string[] = [];
	for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
		files.push(path.relative(cwd, path.join(root, file)).replace(/\\/g, "/"));
	}
	return files.sort((a, b) => a.localeCompare(b));
}

export async function readManyFiles(input: {
	cwd: string;
	include: string[];
	exclude?: string[];
	recursive?: boolean;
}): Promise<string> {
	const excluded = new Set<string>();
	for (const pattern of input.exclude ?? []) {
		for (const file of await globFiles(input.cwd, pattern)) excluded.add(file);
	}
	const files = new Set<string>();
	for (const pattern of input.include) {
		for (const file of await globFiles(input.cwd, pattern)) {
			if (!excluded.has(file)) files.add(file);
		}
	}
	const chunks: string[] = [];
	for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
		const absolutePath = resolvePath(input.cwd, file);
		const fileStat = await stat(absolutePath);
		if (!fileStat.isFile()) continue;
		chunks.push(`--- ${file} ---\n${await readFile(absolutePath, "utf-8")}`);
	}
	return chunks.join("\n\n");
}

export async function grepFiles(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	pattern: string;
	dirPath?: string;
	include?: string;
	signal?: AbortSignal;
}): Promise<TextToolResult> {
	const dir = input.dirPath ? resolvePath(input.ctx.cwd, input.dirPath) : input.ctx.cwd;
	const include = input.include ? ` --glob ${JSON.stringify(input.include)}` : "";
	const command = `rg --line-number --no-heading${include} ${JSON.stringify(input.pattern)} ${JSON.stringify(dir)}`;
	return runShell({ pi: input.pi, ctx: input.ctx, command, workdir: input.ctx.cwd, signal: input.signal });
}

export async function readImageFile(cwd: string, filePath: string): Promise<ImageToolResult> {
	const absolutePath = resolvePath(cwd, filePath);
	const ext = path.extname(absolutePath).toLowerCase();
	const mimeType = ext === ".jpg" || ext === ".jpeg"
		? "image/jpeg"
		: ext === ".webp"
			? "image/webp"
			: "image/png";
	const data = Buffer.from(await readFile(absolutePath)).toString("base64");
	return { content: [{ type: "image", data, mimeType }], details: { path: absolutePath } };
}

interface PatchOperation {
	kind: "add" | "delete" | "update";
	path: string;
	moveTo?: string;
	lines: string[];
}

function isPatchHeader(line: string): boolean {
	return line.startsWith("*** Add File: ")
		|| line.startsWith("*** Delete File: ")
		|| line.startsWith("*** Update File: ")
		|| line === "*** End Patch";
}

export function parseApplyPatch(patch: string): PatchOperation[] {
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "*** Begin Patch") throw new Error("Patch must start with *** Begin Patch");
	const operations: PatchOperation[] = [];
	let index = 1;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line === "*** End Patch") return operations;
		const add = line.match(/^\*\*\* Add File: (.+)$/);
		const del = line.match(/^\*\*\* Delete File: (.+)$/);
		const upd = line.match(/^\*\*\* Update File: (.+)$/);
		if (!add && !del && !upd) throw new Error(`Invalid patch header: ${line}`);
		index++;

		let moveTo: string | undefined;
		if (upd && lines[index]?.startsWith("*** Move to: ")) {
			moveTo = lines[index]!.slice("*** Move to: ".length);
			index++;
		}

		const body: string[] = [];
		while (index < lines.length && !isPatchHeader(lines[index]!)) {
			body.push(lines[index]!);
			index++;
		}
		operations.push({
			kind: add ? "add" : del ? "delete" : "update",
			path: (add?.[1] ?? del?.[1] ?? upd?.[1])!,
			moveTo,
			lines: body,
		});
	}
	throw new Error("Patch must end with *** End Patch");
}

function applyUpdateHunks(content: string, lines: string[]): string {
	let next = content;
	let hunk: string[] = [];
	const flush = () => {
		if (hunk.length === 0) return;
		const oldBlock = hunk.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1)).join("\n");
		const newBlock = hunk.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1)).join("\n");
		if (!oldBlock) throw new Error("Update hunk has no removable/context lines");
		if (!next.includes(oldBlock)) throw new Error(`Update hunk context not found:\n${oldBlock}`);
		next = next.replace(oldBlock, newBlock);
		hunk = [];
	};

	for (const line of lines) {
		if (line.startsWith("@@")) {
			flush();
			continue;
		}
		if (!line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-")) {
			throw new Error(`Invalid hunk line: ${line}`);
		}
		hunk.push(line);
	}
	flush();
	return next;
}

export async function applyPatch(cwd: string, patch: string): Promise<string[]> {
	const changed: string[] = [];
	for (const operation of parseApplyPatch(patch)) {
		const absolutePath = resolvePath(cwd, operation.path);
		if (operation.kind === "add") {
			const content = operation.lines.map((line) => {
				if (!line.startsWith("+")) throw new Error(`Add file lines must start with +: ${operation.path}`);
				return line.slice(1);
			}).join("\n");
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, content, "utf-8");
			changed.push(operation.path);
		} else if (operation.kind === "delete") {
			await rm(absolutePath);
			changed.push(operation.path);
		} else {
			const current = await readFile(absolutePath, "utf-8");
			const edited = applyUpdateHunks(current, operation.lines);
			await writeFile(absolutePath, edited, "utf-8");
			if (operation.moveTo) {
				const target = resolvePath(cwd, operation.moveTo);
				await mkdir(path.dirname(target), { recursive: true });
				await rename(absolutePath, target);
				changed.push(`${operation.path} -> ${operation.moveTo}`);
			} else {
				changed.push(operation.path);
			}
		}
	}
	return changed;
}

