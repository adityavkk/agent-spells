import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "./pi-compat";
import type { ReadCoverageState, ReadFreshness, ReadHistory } from "./read-history";
import { describeReadCoverage } from "./read-history";
import { textResult, type ToolTextResult } from "./results";

export interface WriteProviderTextFileInput {
	path: string;
	content: string;
	readHistory?: ReadHistory;
	signal?: AbortSignal;
}

export interface WriteTextDetails {
	path: string;
	bytes: number;
	overwrote: boolean;
	readHistory: ReadFreshness;
	readCoverage: ReadCoverageState;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function writeProviderTextFile(input: WriteProviderTextFileInput): Promise<ToolTextResult<WriteTextDetails>> {
	return withFileMutationQueue(input.path, async () => {
		throwIfAborted(input.signal);
		const overwrote = await fileExists(input.path);
		const readHistory = overwrote && input.readHistory ? await input.readHistory.checkFreshness(input.path) : "missing";
		const readCoverage = describeReadCoverage(overwrote && input.readHistory ? await input.readHistory.getCoverage(input.path) : undefined, readHistory);
		throwIfAborted(input.signal);
		await mkdir(dirname(input.path), { recursive: true });
		throwIfAborted(input.signal);
		await writeFile(input.path, input.content, "utf8");
		throwIfAborted(input.signal);
		return textResult(`Wrote ${input.path}`, {
			path: input.path,
			bytes: Buffer.byteLength(input.content, "utf8"),
			overwrote,
			readHistory,
			readCoverage,
		});
	});
}
