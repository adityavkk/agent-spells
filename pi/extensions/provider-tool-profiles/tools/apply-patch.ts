import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { applyExactEditsToText, resolveToolPath, textResult, withPathQueue, type ToolTextResult } from "./shared";

type PatchOperation =
	| { kind: "add"; path: string; content: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; hunks: Array<{ oldText: string; newText: string }>; moveTo?: string };

function cleanLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseMoveTo(line: string): string | undefined {
	const match = cleanLine(line).match(/^\*\*\* Move to: (.+)$/);
	return match?.[1]?.trim();
}

function parseHunks(lines: string[]): Array<{ oldText: string; newText: string }> {
	const hunks: Array<{ oldText: string; newText: string }> = [];
	let oldLines: string[] = [];
	let newLines: string[] = [];
	let inHunk = false;
	const flush = () => {
		if (!inHunk) return;
		if (oldLines.length === 0) throw new Error("Patch hunk has no removable/context lines; add context for safe replacement");
		hunks.push({ oldText: oldLines.join("\n"), newText: newLines.join("\n") });
		oldLines = [];
		newLines = [];
	};

	for (const rawLine of lines) {
		const line = cleanLine(rawLine);
		if (line.startsWith("@@")) {
			flush();
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		const prefix = line[0];
		const body = line.slice(1);
		if (prefix === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (prefix === "-") {
			oldLines.push(body);
		} else if (prefix === "+") {
			newLines.push(body);
		} else if (line === "\\ No newline at end of file") {
			continue;
		} else {
			throw new Error(`Unsupported patch line: ${line}`);
		}
	}
	flush();
	return hunks;
}

export function parseApplyPatch(input: string): PatchOperation[] {
	const lines = input.split("\n");
	const first = lines.findIndex((line) => cleanLine(line) === "*** Begin Patch");
	const last = lines.findIndex((line) => cleanLine(line) === "*** End Patch");
	if (first === -1 || last === -1 || last <= first) throw new Error("Patch must include *** Begin Patch and *** End Patch markers");

	const ops: PatchOperation[] = [];
	let i = first + 1;
	while (i < last) {
		const line = cleanLine(lines[i] ?? "");
		if (!line.trim()) {
			i += 1;
			continue;
		}
		const add = line.match(/^\*\*\* Add File: (.+)$/);
		const del = line.match(/^\*\*\* Delete File: (.+)$/);
		const upd = line.match(/^\*\*\* Update File: (.+)$/);
		if (parseMoveTo(line)) throw new Error("*** Move to: is only supported after *** Update File:");
		if (add) {
			const body: string[] = [];
			i += 1;
			while (i < last && !cleanLine(lines[i] ?? "").startsWith("*** ")) {
				const bodyLine = cleanLine(lines[i] ?? "");
				body.push(bodyLine.startsWith("+") ? bodyLine.slice(1) : bodyLine);
				i += 1;
			}
			ops.push({ kind: "add", path: add[1]!.trim(), content: body.join("\n") });
			continue;
		}
		if (del) {
			ops.push({ kind: "delete", path: del[1]!.trim() });
			i += 1;
			continue;
		}
		if (upd) {
			const body: string[] = [];
			let moveTo: string | undefined;
			i += 1;
			while (i < last && !cleanLine(lines[i] ?? "").trim()) i += 1;
			const nextMove = i < last ? parseMoveTo(lines[i] ?? "") : undefined;
			if (nextMove) {
				moveTo = nextMove;
				i += 1;
			}
			while (i < last && !cleanLine(lines[i] ?? "").startsWith("*** ")) {
				body.push(lines[i] ?? "");
				i += 1;
			}
			ops.push({ kind: "update", path: upd[1]!.trim(), hunks: parseHunks(body), moveTo });
			continue;
		}
		throw new Error(`Unsupported patch directive: ${line}`);
	}
	return ops;
}

export async function applyPatch(cwd: string, input: string): Promise<ToolTextResult> {
	const ops = parseApplyPatch(input);
	const changed: string[] = [];
	for (const op of ops) {
		const path = resolveToolPath(cwd, op.path);
		await withPathQueue(path, async () => {
			if (op.kind === "add") {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, op.content, "utf8");
				changed.push(`added ${op.path}`);
				return;
			}
			if (op.kind === "delete") {
				await rm(path);
				changed.push(`deleted ${op.path}`);
				return;
			}
			const current = await readFile(path, "utf8");
			const { text, replacements } = applyExactEditsToText(current, op.hunks.map((hunk) => ({
				old_string: hunk.oldText,
				new_string: hunk.newText,
			})));
			await writeFile(path, text, "utf8");
			if (op.moveTo) {
				const targetPath = resolveToolPath(cwd, op.moveTo);
				if (targetPath !== path) {
					await withPathQueue(targetPath, async () => {
						await mkdir(dirname(targetPath), { recursive: true });
						await rename(path, targetPath);
					});
				}
				changed.push(`moved ${op.path} -> ${op.moveTo}`);
				return;
			}
			changed.push(`updated ${op.path} (${replacements.reduce((sum, count) => sum + count, 0)} hunk replacement(s))`);
		});
	}
	return textResult(changed.join("\n") || "No patch operations", { operations: ops.length });
}
