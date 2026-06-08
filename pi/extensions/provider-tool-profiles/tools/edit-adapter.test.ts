import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editProviderTextFile } from "./edit-adapter";
import { createReadHistory } from "./read-history";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-edit-adapter-"));
}

describe("provider edit adapter", () => {
	it("applies sequential exact edits under one provider adapter", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "one\ntwo\n");

		const result = await editProviderTextFile({
			path,
			edits: [
				{ old_string: "two", new_string: "one" },
				{ old_string: "one", new_string: "zero", replace_all: true },
			],
		});

		expect(readFileSync(path, "utf8")).toBe("zero\nzero\n");
		expect(result.details).toMatchObject({ replacements: [1, 2], readHistory: "missing" });
	});

	it("adds fresh and stale read-history audit details", async () => {
		const root = tempRoot();
		const freshPath = join(root, "fresh.txt");
		const stalePath = join(root, "stale.txt");
		writeFileSync(freshPath, "old\n");
		writeFileSync(stalePath, "old\n");
		const readHistory = createReadHistory();
		await readHistory.recordRead({ path: freshPath, profile: "claude", toolName: "Read", kind: "text" });
		await readHistory.recordRead({ path: stalePath, profile: "claude", toolName: "Read", kind: "text" });
		writeFileSync(stalePath, "old changed\n");

		const fresh = await editProviderTextFile({ path: freshPath, edits: [{ old_string: "old", new_string: "new" }], readHistory });
		const stale = await editProviderTextFile({ path: stalePath, edits: [{ old_string: "old", new_string: "new" }], readHistory });

		expect(fresh.details?.readHistory).toBe("fresh");
		expect(stale.details?.readHistory).toBe("stale");
	});

	it("does not write when already aborted", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "old\n");
		const controller = new AbortController();
		controller.abort();

		await expect(editProviderTextFile({ path, edits: [{ old_string: "old", new_string: "new" }], signal: controller.signal })).rejects.toThrow("Operation aborted");

		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("old\n");
	});
});
