import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadHistory } from "./read-history";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-read-history-"));
}

describe("provider tool read history", () => {
	it("records successful text reads and reports fresh files", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "hello\n");
		const history = createReadHistory();

		const record = await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "text" });

		expect(record.path.endsWith("/file.txt")).toBe(true);
		expect(record.sha256).toHaveLength(64);
		expect(await history.checkFreshness(path)).toBe("fresh");
	});

	it("reports stale files after content changes", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "before\n");
		const history = createReadHistory();
		await history.recordRead({ path, profile: "gemini", toolName: "read_file", kind: "text" });

		writeFileSync(path, "after\n");

		expect(await history.checkFreshness(path)).toBe("stale");
	});

	it("does not treat image reads as text-edit confidence", async () => {
		const root = tempRoot();
		const path = join(root, "image.png");
		writeFileSync(path, "fake image");
		const history = createReadHistory();
		await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "image" });

		expect(await history.checkFreshness(path)).toBe("missing");
		expect(await history.checkFreshness(path, { kind: "image" })).toBe("fresh");
	});

	it("accumulates partial read ranges and reports coverage", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "l1\nl2\nl3\nl4\n");
		const history = createReadHistory();

		await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "text", fileLines: 4, range: { start: 0, end: 2 } });
		expect(await history.getCoverage(path)).toMatchObject({ full: false, coveredLines: 2, fileLines: 4 });

		await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "text", fileLines: 4, range: { start: 2, end: 4 } });
		expect(await history.getCoverage(path)).toMatchObject({ full: true, coveredLines: 4, fileLines: 4 });
	});

	it("treats a whole-file read with no range as full coverage", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "l1\nl2\n");
		const history = createReadHistory();

		await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "text", fileLines: 2 });

		expect(await history.getCoverage(path)).toMatchObject({ full: true });
	});

	it("resets accumulated coverage when the file changes between reads", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "l1\nl2\nl3\nl4\n");
		const history = createReadHistory();
		await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "text", fileLines: 4, range: { start: 0, end: 2 } });

		writeFileSync(path, "l1\nl2\nl3\nl4\nl5\n");
		await history.recordRead({ path, profile: "claude", toolName: "Read", kind: "text", fileLines: 5, range: { start: 4, end: 5 } });

		expect(await history.getCoverage(path)).toMatchObject({ full: false, coveredLines: 1, fileLines: 5 });
	});

	it("canonicalizes through existing symlinks", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "real"));
		const realPath = join(root, "real", "file.txt");
		const linkPath = join(root, "link.txt");
		writeFileSync(realPath, "hello\n");
		symlinkSync(realPath, linkPath);
		const history = createReadHistory();

		await history.recordRead({ path: linkPath, profile: "claude", toolName: "Read", kind: "text" });

		expect(await history.checkFreshness(realPath)).toBe("fresh");
	});
});
