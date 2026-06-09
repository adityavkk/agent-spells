import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderProfile } from "./policies";

export type ReadKind = "text" | "image";
export type ReadFreshness = "missing" | "stale" | "fresh";

/**
 * Line coverage for a text read, used to distinguish "the file is byte-for-byte
 * unchanged since a read" (freshness) from "the model actually saw the lines it
 * is about to edit" (coverage). A partial read of a long file can still be
 * `fresh` while only covering a small slice, so write/edit audits expose both.
 */
export interface ReadCoverage {
	full: boolean;
	coveredLines: number;
	fileLines: number;
}

/** A half-open `[start, end)` line range, 0-based. */
export interface ReadRange {
	start: number;
	end: number;
}

/**
 * Audit-facing summary of how much of a file a prior read covered:
 * - `unknown`: no usable text read on record (missing/mismatched kind).
 * - `full`: every line was served by one or more prior reads.
 * - `partial`: the file was read, but only a subset of lines was served.
 */
export type ReadCoverageState = "unknown" | "full" | "partial";

export interface ReadRecord {
	path: string;
	profile: ProviderProfile;
	toolName: string;
	kind: ReadKind;
	mtimeMs: number;
	size: number;
	sha256: string;
	fileLines: number;
	ranges: Array<[number, number]>;
	readAtTurnId?: string;
}

export interface RecordReadInput {
	path: string;
	profile: ProviderProfile;
	toolName: string;
	kind: ReadKind;
	/** Lines served this read, half-open and 0-based. Omit for whole-file reads. */
	range?: ReadRange;
	/** Total line count of the file as read. Required to compute full coverage. */
	fileLines?: number;
	readAtTurnId?: string;
}

export interface ReadHistory {
	clear(): void;
	recordRead(input: RecordReadInput): Promise<ReadRecord>;
	checkFreshness(path: string, options?: { kind?: ReadKind }): Promise<ReadFreshness>;
	getCoverage(path: string, options?: { kind?: ReadKind }): Promise<ReadCoverage | undefined>;
	get(path: string): Promise<ReadRecord | undefined>;
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

async function fingerprint(path: string): Promise<{ mtimeMs: number; size: number; sha256: string }> {
	const [stats, bytes] = await Promise.all([stat(path), readFile(path)]);
	return {
		mtimeMs: stats.mtimeMs,
		size: stats.size,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function matchesRecord(record: ReadRecord, current: { mtimeMs: number; size: number; sha256: string }): boolean {
	return record.size === current.size && record.mtimeMs === current.mtimeMs && record.sha256 === current.sha256;
}

/** Merge half-open ranges into sorted, inclusive `[start, end]` segments. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const sorted = ranges.filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

function inclusiveSegment(range: ReadRange | undefined, fileLines: number): [number, number] | undefined {
	const start = Math.max(0, Math.floor(range?.start ?? 0));
	const endExclusive = range ? Math.floor(range.end) : fileLines;
	const end = Math.min(fileLines, endExclusive) - 1;
	return end >= start ? [start, end] : undefined;
}

function coverageOf(record: ReadRecord): ReadCoverage {
	const coveredLines = record.ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
	const full = record.fileLines === 0 ? true : coveredLines >= record.fileLines;
	return { full, coveredLines, fileLines: record.fileLines };
}

/**
 * Collapse freshness + coverage into a single audit signal. Coverage is only
 * meaningful when the file is otherwise fresh; a stale/missing read should not
 * be reported as "full" just because earlier ranges happened to span the file.
 */
export function describeReadCoverage(coverage: ReadCoverage | undefined, freshness: ReadFreshness): ReadCoverageState {
	if (freshness !== "fresh" || !coverage) return "unknown";
	return coverage.full ? "full" : "partial";
}

export function createReadHistory(): ReadHistory {
	const records = new Map<string, ReadRecord>();

	return {
		clear() {
			records.clear();
		},

		async recordRead(input) {
			const path = await canonicalPath(input.path);
			const current = await fingerprint(path);
			const fileLines = input.kind === "text" ? Math.max(0, Math.floor(input.fileLines ?? 0)) : 0;
			const segment = input.kind === "text" ? inclusiveSegment(input.range, fileLines) : undefined;
			const previous = records.get(path);
			// Accumulate coverage only while the bytes and line count are unchanged;
			// any external edit invalidates prior ranges, so we start clean.
			const reuse = previous?.kind === "text" && previous.fileLines === fileLines && matchesRecord(previous, current);
			const baseRanges = reuse ? previous.ranges : [];
			const ranges = mergeRanges(segment ? [...baseRanges, segment] : [...baseRanges]);
			const record: ReadRecord = { path, ...current, profile: input.profile, toolName: input.toolName, kind: input.kind, fileLines, ranges };
			if (input.readAtTurnId !== undefined) record.readAtTurnId = input.readAtTurnId;
			records.set(path, record);
			return record;
		},

		async checkFreshness(path, options = {}) {
			const canonical = await canonicalPath(path);
			const record = records.get(canonical);
			if (!record) return "missing";
			if ((options.kind ?? "text") !== record.kind) return "missing";
			try {
				const current = await fingerprint(canonical);
				return matchesRecord(record, current) ? "fresh" : "stale";
			} catch {
				return "stale";
			}
		},

		async getCoverage(path, options = {}) {
			const canonical = await canonicalPath(path);
			const record = records.get(canonical);
			if (!record) return undefined;
			if ((options.kind ?? "text") !== record.kind) return undefined;
			return coverageOf(record);
		},

		async get(path) {
			return records.get(await canonicalPath(path));
		},
	};
}
