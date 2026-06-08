import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadHistory } from "./read-history";
import { writeProviderTextFile } from "./write-adapter";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-write-adapter-"));
}

describe("provider write adapter", () => {
	it("creates parent directories and writes content", async () => {
		const root = tempRoot();
		const path = join(root, "nested", "file.txt");

		const result = await writeProviderTextFile({ path, content: "hello\n" });

		expect(readFileSync(path, "utf8")).toBe("hello\n");
		expect(result.content[0]?.text).toBe(`Wrote ${path}`);
		expect(result.details).toMatchObject({ path, bytes: 6, overwrote: false, readHistory: "missing" });
	});

	it("adds fresh and stale read-history audit details before overwrites", async () => {
		const root = tempRoot();
		const freshPath = join(root, "fresh.txt");
		const stalePath = join(root, "stale.txt");
		writeFileSync(freshPath, "old\n");
		writeFileSync(stalePath, "old\n");
		const readHistory = createReadHistory();
		await readHistory.recordRead({ path: freshPath, profile: "claude", toolName: "Read", kind: "text" });
		await readHistory.recordRead({ path: stalePath, profile: "claude", toolName: "Read", kind: "text" });
		writeFileSync(stalePath, "changed elsewhere\n");

		const fresh = await writeProviderTextFile({ path: freshPath, content: "new\n", readHistory });
		const stale = await writeProviderTextFile({ path: stalePath, content: "new\n", readHistory });

		expect(fresh.details?.readHistory).toBe("fresh");
		expect(stale.details?.readHistory).toBe("stale");
	});

	it("does not write when already aborted", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		const controller = new AbortController();
		controller.abort();

		await expect(writeProviderTextFile({ path, content: "nope", signal: controller.signal })).rejects.toThrow("Operation aborted");

		expect(existsSync(path)).toBe(false);
	});
});
