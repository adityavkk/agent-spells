import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExactEditsToText, resolveToolPath } from "./shared";

describe("provider tool shared helpers", () => {
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

	it("resolves Claude-style paths through the shared compatibility helper", () => {
		const root = mkdtempSync(join(tmpdir(), "provider-tools-"));

		expect(resolveToolPath(root, "src/a.txt")).toBe(join(root, "src", "a.txt"));
	});

});
