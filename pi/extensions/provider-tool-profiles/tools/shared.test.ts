import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExactEdits, applyExactEditsToText, readTextFile, resolveToolPath, writeTextFile } from "./shared";

describe("provider tool shared file adapters", () => {
	it("applies exact single and multi replacements", () => {
		const result = applyExactEditsToText("one\ntwo\none\n", [
			{ old_string: "two", new_string: "three" },
			{ old_string: "one", new_string: "zero", replace_all: true },
		]);
		expect(result.text).toBe("zero\nthree\nzero\n");
		expect(result.replacements).toEqual([1, 2]);
	});

	it("requires unique replacement unless replace_all or expected_replacements is set", () => {
		expect(() => applyExactEditsToText("x x", [{ old_string: "x", new_string: "y" }])).toThrow("expected 1 replacement(s), found 2");
		expect(applyExactEditsToText("x x", [{ old_string: "x", new_string: "y", expected_replacements: 2 }]).text).toBe("y y");
	});

	it("reads, writes, and edits files through resolved paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-tools-"));
		mkdirSync(join(root, "src"));
		const path = resolveToolPath(root, "src/a.txt");
		await writeTextFile(path, "a\nb\nc\n");
		expect(readFileSync(path, "utf8")).toBe("a\nb\nc\n");
		const read = await readTextFile(path, { offset: 1, limit: 1, offsetBase: 0 });
		expect(read.content[0]?.text).toBe("b");
		await applyExactEdits(path, [{ old_string: "b", new_string: "B" }]);
		expect(readFileSync(path, "utf8")).toBe("a\nB\nc\n");
	});
});
