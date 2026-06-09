import { readFile, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "./pi-compat";
import type { ReadCoverageState, ReadFreshness, ReadHistory } from "./read-history";
import { describeReadCoverage } from "./read-history";
import { textResult, type ToolTextResult } from "./results";
import { applyExactEditsToText, type ExactEdit } from "./shared";

export interface EditProviderTextFileInput {
	path: string;
	edits: ExactEdit[];
	readHistory?: ReadHistory;
	signal?: AbortSignal;
}

export interface EditTextDetails {
	path: string;
	replacements: number[];
	bytes: number;
	readHistory: ReadFreshness;
	readCoverage: ReadCoverageState;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export async function editProviderTextFile(input: EditProviderTextFileInput): Promise<ToolTextResult<EditTextDetails>> {
	return withFileMutationQueue(input.path, async () => {
		throwIfAborted(input.signal);
		const readHistory = input.readHistory ? await input.readHistory.checkFreshness(input.path) : "missing";
		const readCoverage = describeReadCoverage(input.readHistory ? await input.readHistory.getCoverage(input.path) : undefined, readHistory);
		throwIfAborted(input.signal);
		const current = await readFile(input.path, "utf8");
		throwIfAborted(input.signal);
		const { text, replacements } = applyExactEditsToText(current, input.edits);
		throwIfAborted(input.signal);
		await writeFile(input.path, text, "utf8");
		throwIfAborted(input.signal);
		const total = replacements.reduce((sum, count) => sum + count, 0);
		return textResult(`Applied ${total} replacement(s) to ${input.path}`, {
			path: input.path,
			replacements,
			bytes: Buffer.byteLength(text, "utf8"),
			readHistory,
			readCoverage,
		});
	});
}
