/**
 * Codex `apply_patch` engine.
 *
 * Codex's apply-patch grammar (`*** Begin Patch` ... `*** End Patch`) has no
 * Pi-native equivalent, so this engine is implemented locally. It follows the
 * safety contract in `docs/tool-behavior-matrix.md`:
 *
 * 1. Paths are relative-only and contained within `cwd` (see `path.ts`).
 * 2. The patch is parsed and fully resolved in a read-only **preflight** that
 *    produces an in-memory write plan. No file is mutated until every operation
 *    has parsed, passed path policy, and been computed.
 * 3. The plan is then **committed**. If any write/delete/rename fails midway,
 *    previously applied operations are rolled back from in-memory snapshots on
 *    a best-effort basis. This is not crash-safe atomicity, and we never claim
 *    it is.
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePatchPath } from "./path";
import { applyExactEditsToText, textResult, withPathQueue, type ToolTextResult } from "./shared";

type PatchOperation =
	| { kind: "add"; path: string; content: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; hunks: Array<{ oldText: string; newText: string }>; moveTo?: string };

/** A single operation after path resolution and in-memory computation. */
type ResolvedOperation =
	| { kind: "add"; relativePath: string; absolutePath: string; content: string }
	| { kind: "delete"; relativePath: string; absolutePath: string }
	| {
			kind: "update";
			relativePath: string;
			absolutePath: string;
			nextText: string;
			replacements: number[];
			move?: { relativePath: string; absolutePath: string };
	  };

/** Snapshot of a file's bytes before mutation, used for best-effort rollback. */
type Snapshot = { present: true; content: Buffer } | { present: false };

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

/**
 * Parse a Codex patch envelope into structured operations.
 *
 * Pure and filesystem-free: this only inspects text so it stays trivially
 * testable and can run during preflight without side effects.
 */
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

/** Resolve a raw patch path or throw a clear, directive-tagged policy error. */
async function resolveOrThrow(cwd: string, rawPath: string, directive: string): Promise<{ absolutePath: string; relativePath: string }> {
	const resolved = await resolvePatchPath(cwd, rawPath);
	if (!resolved.ok) throw new Error(`${directive} "${rawPath}": ${resolved.reason}`);
	return { absolutePath: resolved.absolutePath, relativePath: resolved.relativePath };
}

/**
 * Read-only preflight: resolve every path and compute the resulting file
 * contents in memory. Throws before any disk mutation if a path violates
 * policy, a target for update/delete is missing, or a hunk does not apply.
 */
async function preflight(cwd: string, ops: PatchOperation[]): Promise<ResolvedOperation[]> {
	const resolved: ResolvedOperation[] = [];
	const reservedMutations = new Map<string, string>();
	for (const op of ops) {
		const { absolutePath, relativePath } = await resolveOrThrow(cwd, op.path, directiveLabel(op.kind));
		if (op.kind === "add") {
			await assertPathDoesNotExist(absolutePath, relativePath, "Add File");
			reserveMutation(reservedMutations, absolutePath, relativePath, "Add File");
			resolved.push({ kind: "add", relativePath, absolutePath, content: op.content });
			continue;
		}
		if (op.kind === "delete") {
			await readExisting(absolutePath, relativePath, "Delete File");
			reserveMutation(reservedMutations, absolutePath, relativePath, "Delete File");
			resolved.push({ kind: "delete", relativePath, absolutePath });
			continue;
		}
		const current = await readExisting(absolutePath, relativePath, "Update File");
		reserveMutation(reservedMutations, absolutePath, relativePath, "Update File");
		const { text, replacements } = applyExactEditsToText(
			current,
			op.hunks.map((hunk) => ({ old_string: hunk.oldText, new_string: hunk.newText })),
		);
		let move: { relativePath: string; absolutePath: string } | undefined;
		if (op.moveTo) {
			const target = await resolveOrThrow(cwd, op.moveTo, "Move to");
			if (target.absolutePath !== absolutePath) {
				await assertPathDoesNotExist(target.absolutePath, target.relativePath, "Move to");
				reserveMutation(reservedMutations, target.absolutePath, target.relativePath, "Move to");
				move = target;
			}
		}
		resolved.push({ kind: "update", relativePath, absolutePath, nextText: text, replacements, move });
	}
	return resolved;
}

function directiveLabel(kind: PatchOperation["kind"]): string {
	return kind === "add" ? "Add File" : kind === "delete" ? "Delete File" : "Update File";
}

function reserveMutation(reserved: Map<string, string>, absolutePath: string, relativePath: string, directive: string): void {
	const previous = reserved.get(absolutePath);
	if (previous) throw new Error(`${directive} "${relativePath}": path is already modified by ${previous}`);
	reserved.set(absolutePath, `${directive} "${relativePath}"`);
}

async function assertPathDoesNotExist(absolutePath: string, relativePath: string, directive: string): Promise<void> {
	try {
		await lstat(absolutePath);
		throw new Error(`${directive} "${relativePath}": file already exists`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

async function readExisting(absolutePath: string, relativePath: string, directive: string): Promise<string> {
	try {
		return await readFile(absolutePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${directive} "${relativePath}": file does not exist`);
		throw error;
	}
}

async function readSnapshot(absolutePath: string): Promise<Snapshot> {
	try {
		return { present: true, content: await readFile(absolutePath) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
		throw error;
	}
}

async function restoreSnapshot(absolutePath: string, snapshot: Snapshot): Promise<void> {
	if (snapshot.present) {
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, snapshot.content);
	} else {
		await rm(absolutePath, { force: true });
	}
}

/**
 * Commit a preflighted plan. Each operation captures a snapshot immediately
 * before mutating, registers an undo closure, and on any failure the applied
 * operations are rolled back in reverse order.
 */
async function commit(plan: ResolvedOperation[]): Promise<ToolTextResult> {
	const changed: string[] = [];
	const undos: Array<() => Promise<void>> = [];

	try {
		for (const op of plan) {
			if (op.kind === "add") {
				await withPathQueue(op.absolutePath, async () => {
					const before = await readSnapshot(op.absolutePath);
					await assertPathDoesNotExist(op.absolutePath, op.relativePath, "Add File");
					await mkdir(dirname(op.absolutePath), { recursive: true });
					await writeFile(op.absolutePath, op.content, { encoding: "utf8", flag: "wx" });
					undos.push(() => restoreSnapshot(op.absolutePath, before));
				});
				changed.push(`added ${op.relativePath}`);
				continue;
			}
			if (op.kind === "delete") {
				await withPathQueue(op.absolutePath, async () => {
					const before = await readSnapshot(op.absolutePath);
					await rm(op.absolutePath, { force: true });
					undos.push(() => restoreSnapshot(op.absolutePath, before));
				});
				changed.push(`deleted ${op.relativePath}`);
				continue;
			}
			await commitUpdate(op, undos);
			changed.push(
				op.move
					? `moved ${op.relativePath} -> ${op.move.relativePath}`
					: `updated ${op.relativePath} (${op.replacements.reduce((sum, count) => sum + count, 0)} hunk replacement(s))`,
			);
		}
	} catch (error) {
		const rollbackOk = await rollback(undos);
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`apply_patch failed during commit: ${reason}. Rollback ${rollbackOk ? "succeeded" : "incomplete; inspect the workspace"}.`);
	}

	return textResult(changed.join("\n") || "No patch operations", { operations: plan.length });
}

async function commitUpdate(op: Extract<ResolvedOperation, { kind: "update" }>, undos: Array<() => Promise<void>>): Promise<void> {
	await withPathQueue(op.absolutePath, async () => {
		const beforeSource = await readSnapshot(op.absolutePath);
		if (!op.move) {
			await writeFile(op.absolutePath, op.nextText, "utf8");
			undos.push(() => restoreSnapshot(op.absolutePath, beforeSource));
			return;
		}

		const move = op.move;
		await withPathQueue(move.absolutePath, async () => {
			const beforeTarget = await readSnapshot(move.absolutePath);
			await assertPathDoesNotExist(move.absolutePath, move.relativePath, "Move to");

			let moved = false;
			undos.push(async () => {
				if (moved) {
					await rm(op.absolutePath, { force: true });
					await rename(move.absolutePath, op.absolutePath).catch(() => undefined);
				}
				await restoreSnapshot(move.absolutePath, beforeTarget);
				await restoreSnapshot(op.absolutePath, beforeSource);
			});

			await writeFile(op.absolutePath, op.nextText, "utf8");
			await mkdir(dirname(move.absolutePath), { recursive: true });
			await assertPathDoesNotExist(move.absolutePath, move.relativePath, "Move to");
			await rename(op.absolutePath, move.absolutePath);
			moved = true;
		});
	});
}

async function rollback(undos: Array<() => Promise<void>>): Promise<boolean> {
	let ok = true;
	for (const undo of undos.reverse()) {
		try {
			await undo();
		} catch {
			ok = false;
		}
	}
	return ok;
}

/**
 * Apply a Codex patch under `cwd`. Parses, preflights into an in-memory plan,
 * then commits with best-effort rollback. No disk mutation occurs unless the
 * entire patch parses, passes path policy, and computes cleanly.
 */
export async function applyPatch(cwd: string, input: string): Promise<ToolTextResult> {
	const ops = parseApplyPatch(input);
	const plan = await preflight(cwd, ops);
	return commit(plan);
}
