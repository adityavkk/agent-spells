import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

	it("rejects Add File when the target already exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-patch-add-exists-"));
		writeFileSync(join(root, "existing.txt"), "old\n");

		await expect(
			applyPatch(root, `*** Begin Patch
*** Add File: existing.txt
+new
*** End Patch`),
		).rejects.toThrow('Add File "existing.txt": file already exists');

		expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("old\n");
	});

	it("rejects moves when the target already exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-patch-move-exists-"));
		writeFileSync(join(root, "old.txt"), "alpha\nold\nomega\n");
		writeFileSync(join(root, "new.txt"), "keep me\n");

		await expect(
			applyPatch(root, `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
 alpha
-old
+new
 omega
*** End Patch`),
		).rejects.toThrow('Move to "new.txt": file already exists');

		expect(readFileSync(join(root, "old.txt"), "utf8")).toBe("alpha\nold\nomega\n");
		expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("keep me\n");
	});

	it("rejects multiple mutations of one patch path", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-patch-conflict-"));
		writeFileSync(join(root, "file.txt"), "alpha\none\nomega\n");

		await expect(
			applyPatch(root, `*** Begin Patch
*** Update File: file.txt
@@
 alpha
-one
+two
 omega
*** Update File: file.txt
@@
 alpha
-one
+three
 omega
*** End Patch`),
		).rejects.toThrow("path is already modified");

		expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("alpha\none\nomega\n");
	});
});

describe("applyPatch path policy", () => {
	it("rejects absolute target paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-abs-"));
		await expect(
			applyPatch(root, `*** Begin Patch
*** Add File: /tmp/escape.txt
+nope
*** End Patch`),
		).rejects.toThrow("absolute paths are not allowed");
	});

	it("rejects parent-directory traversal", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-traversal-"));
		await expect(
			applyPatch(root, `*** Begin Patch
*** Add File: ../escape.txt
+nope
*** End Patch`),
		).rejects.toThrow("escapes the working directory");
	});

	it("rejects symlink escapes from inside cwd", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-apply-symlink-"));
		const root = join(base, "root");
		const outside = join(base, "outside");
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		symlinkSync(outside, join(root, "link"));
		await expect(
			applyPatch(root, `*** Begin Patch
*** Add File: link/escape.txt
+nope
*** End Patch`),
		).rejects.toThrow("escapes the working directory");
	});
});

describe("applyPatch preflight atomicity", () => {
	it("does not mutate disk when a later operation fails preflight", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-preflight-"));
		writeFileSync(join(root, "exists.txt"), "original\n");

		// First op is a valid add; second op updates a missing file and must fail.
		await expect(
			applyPatch(root, `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: missing.txt
@@
-old
+new
*** End Patch`),
		).rejects.toThrow("does not exist");

		// The earlier add must NOT have touched disk: preflight runs before commit.
		expect(existsSync(join(root, "created.txt"))).toBe(false);
		expect(readFileSync(join(root, "exists.txt"), "utf8")).toBe("original\n");
	});

	it("reports update targets that do not exist", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-missing-"));
		await expect(
			applyPatch(root, `*** Begin Patch
*** Update File: ghost.txt
@@
-old
+new
*** End Patch`),
		).rejects.toThrow("does not exist");
	});

	it("rolls back an applied operation when a later commit step fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-apply-rollback-"));

		// op1 creates the file `blocker`; op2 tries to add `blocker/child.txt`,
		// whose parent is now a file. mkdir fails at commit time (post-preflight),
		// so op1 must be rolled back, leaving the workspace clean.
		await expect(
			applyPatch(root, `*** Begin Patch
*** Add File: blocker
+i am a file
*** Add File: blocker/child.txt
+orphan
*** End Patch`),
		).rejects.toThrow("apply_patch failed during commit");

		expect(existsSync(join(root, "blocker"))).toBe(false);
		expect(existsSync(join(root, "blocker", "child.txt"))).toBe(false);
	});
});
