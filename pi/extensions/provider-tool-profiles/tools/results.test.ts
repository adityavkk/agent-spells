import { describe, expect, it } from "bun:test";
import { textResult, truncateTextHead, truncateTextTail, unsupportedMediaResult } from "./results";

describe("provider tool result helpers", () => {
	it("builds concise text results", () => {
		expect(textResult("ok", { path: "file.txt" })).toEqual({ content: [{ type: "text", text: "ok" }], details: { path: "file.txt" } });
	});

	it("adds explicit truncation notices using Pi truncation metadata", () => {
		const head = truncateTextHead("a\nb\nc", { maxLines: 2, continuationHint: "Use offset 2 to continue." });
		const tail = truncateTextTail("a\nb\nc", { maxLines: 2 });

		expect(head.text).toContain("a\nb");
		expect(head.text).toContain("Output truncated to 2 lines");
		expect(head.text).toContain("Use offset 2 to continue.");
		expect(tail.text).toContain("Output truncated to 2 lines");
		expect(tail.text).toContain("b\nc");
	});

	it("builds unsupported media messages", () => {
		const result = unsupportedMediaResult("file.pdf", "PDF");

		expect(result.content[0]?.text).toContain("PDF support is deferred");
		expect(result.details).toMatchObject({ unsupported: true, path: "file.pdf", mediaKind: "PDF" });
	});
});
