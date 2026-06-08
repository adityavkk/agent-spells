import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProviderFile } from "./read-adapter";
import { createReadHistory } from "./read-history";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-read-adapter-"));
}

describe("provider read adapter", () => {
	it("formats Claude text reads as cat -n with 1-based offsets", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "alpha\nbeta\ngamma\n");

		const result = await readProviderFile({ path, profile: "claude", toolName: "Read", offset: 2, limit: 1 });

		expect(result.content[0]).toEqual({ type: "text", text: "     2\tbeta\n\n[Showing lines 2-2 of 3. Use offset 3 to continue.]" });
		expect(result.details).toMatchObject({ lineCount: 3, offsetBase: 1, textFormat: "cat-n", moreAvailable: true, mediaKind: "text" });
	});

	it("keeps Gemini text reads plain with 0-based offsets", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "alpha\nbeta\ngamma\n");

		const result = await readProviderFile({ path, profile: "gemini", toolName: "read_file", offset: 1, limit: 1 });

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toBe("beta\n\n[Showing lines 2-2 of 3. Use offset 2 to continue.]");
		expect(result.details).toMatchObject({ lineCount: 3, offsetBase: 0, textFormat: "plain", moreAvailable: true, mediaKind: "text" });
	});

	it("records successful text reads in read history", async () => {
		const root = tempRoot();
		const path = join(root, "file.txt");
		writeFileSync(path, "alpha\n");
		const readHistory = createReadHistory();

		await readProviderFile({ path, profile: "claude", toolName: "Read", readHistory });

		expect(await readHistory.checkFreshness(path)).toBe("fresh");
	});

	it("returns images as text plus image content", async () => {
		const root = tempRoot();
		const path = join(root, "image.png");
		writeFileSync(path, "fake image bytes");

		const result = await readProviderFile({ path, profile: "claude", toolName: "Read" });

		expect(result.content[0]).toEqual({ type: "text", text: `Loaded image ${path}` });
		expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from("fake image bytes").toString("base64") });
		expect(result.details).toMatchObject({ mediaKind: "image", mimeType: "image/png" });
	});

	it("returns explicit deferred results for PDFs and binary files", async () => {
		const root = tempRoot();
		const pdf = join(root, "file.pdf");
		const binary = join(root, "file.bin");
		writeFileSync(pdf, "%PDF fake");
		writeFileSync(binary, Buffer.from([0, 1, 2, 3]));

		const pdfResult = await readProviderFile({ path: pdf, profile: "gemini", toolName: "read_file" });
		const binaryResult = await readProviderFile({ path: binary, profile: "gemini", toolName: "read_file" });

		expect((pdfResult.content[0] as { text: string }).text).toContain("PDF support is deferred");
		expect((binaryResult.content[0] as { text: string }).text).toContain("binary file support is deferred");
		expect(pdfResult.details).toMatchObject({ unsupported: true, mediaKind: "PDF" });
		expect(binaryResult.details).toMatchObject({ unsupported: true, mediaKind: "binary" });
	});
});
