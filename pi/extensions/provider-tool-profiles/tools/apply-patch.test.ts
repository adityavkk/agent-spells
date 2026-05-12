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

	it("parses update move directives", () => {
		const ops = parseApplyPatch(`*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new
*** End Patch`);
		expect(ops[0]).toMatchObject({ kind: "update", path: "old.txt", moveTo: "new.txt" });
	});

	it("rejects move directives outside update blocks", () => {
		expect(() => parseApplyPatch(`*** Begin Patch
*** Add File: foo.txt
*** Move to: bar.txt
+content
*** End Patch`)).toThrow("Move to");
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

	it("updates and moves files", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-patch-move-"));
		writeFileSync(join(root, "old.txt"), "alpha\nold\nomega\n");

		const result = await applyPatch(root, `*** Begin Patch
*** Update File: old.txt
*** Move to: nested/new.txt
@@
 alpha
-old
+new
 omega
*** End Patch`);

		expect(existsSync(join(root, "old.txt"))).toBe(false);
		expect(readFileSync(join(root, "nested", "new.txt"), "utf8")).toBe("alpha\nnew\nomega\n");
		expect(result.content[0]?.text).toContain("moved old.txt -> nested/new.txt");
	});
});
