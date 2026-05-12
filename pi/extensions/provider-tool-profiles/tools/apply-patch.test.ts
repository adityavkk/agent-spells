import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, parseApplyPatch } from "./apply-patch";

describe("parseApplyPatch", () => {
	it("parses add, update, and delete operations", () => {
		const ops = parseApplyPatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: b.txt
@@
-old
+new
*** Delete File: c.txt
*** End Patch`);
		expect(ops.map((op) => op.kind)).toEqual(["add", "update", "delete"]);
	});
});

describe("applyPatch", () => {
	it("adds, updates, and deletes files", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-patch-"));
		writeFileSync(join(root, "update.txt"), "alpha\nold\nomega\n");
		writeFileSync(join(root, "delete.txt"), "bye");

		await applyPatch(root, `*** Begin Patch
*** Add File: add.txt
+hello
+world
*** Update File: update.txt
@@
 alpha
-old
+new
 omega
*** Delete File: delete.txt
*** End Patch`);

		expect(readFileSync(join(root, "add.txt"), "utf8")).toBe("hello\nworld");
		expect(readFileSync(join(root, "update.txt"), "utf8")).toBe("alpha\nnew\nomega\n");
		expect(existsSync(join(root, "delete.txt"))).toBe(false);
	});
});
