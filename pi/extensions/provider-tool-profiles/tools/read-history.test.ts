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
