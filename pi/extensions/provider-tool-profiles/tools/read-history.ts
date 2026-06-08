import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderProfile } from "./policies";

export type ReadKind = "text" | "image";
export type ReadFreshness = "missing" | "stale" | "fresh";

export interface ReadRecord {
	path: string;
	profile: ProviderProfile;
	toolName: string;
	kind: ReadKind;
	mtimeMs: number;
	size: number;
	sha256: string;
	readAtTurnId?: string;
}

export interface RecordReadInput {
	path: string;
	profile: ProviderProfile;
	toolName: string;
	kind: ReadKind;
	readAtTurnId?: string;
}

export interface ReadHistory {
	clear(): void;
	recordRead(input: RecordReadInput): Promise<ReadRecord>;
	checkFreshness(path: string, options?: { kind?: ReadKind }): Promise<ReadFreshness>;
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

export function createReadHistory(): ReadHistory {
	const records = new Map<string, ReadRecord>();

	return {
		clear() {
			records.clear();
		},

		async recordRead(input) {
			const path = await canonicalPath(input.path);
			const current = await fingerprint(path);
			const record: ReadRecord = { path, ...current, profile: input.profile, toolName: input.toolName, kind: input.kind };
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

		async get(path) {
			return records.get(await canonicalPath(path));
		},
	};
}
