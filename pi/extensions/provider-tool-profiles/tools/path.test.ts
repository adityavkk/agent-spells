import { describe, expect, it } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinCwd, resolveClaudePath, resolveCodexImagePath, resolveExistingDirectoryUnderCwd, resolveGeminiPath, resolvePatchPath, validatePatchPath } from "./path";

describe("validatePatchPath (Codex relative-only policy)", () => {
	it("accepts relative paths and normalizes them", () => {
		expect(validatePatchPath("src/app.ts")).toEqual({ ok: true, relativePath: "src/app.ts" });
		expect(validatePatchPath("./src/../src/app.ts")).toEqual({ ok: true, relativePath: "src/app.ts" });
		expect(validatePatchPath("  nested/file.txt  ")).toEqual({ ok: true, relativePath: "nested/file.txt" });
	});

	it("rejects empty and NUL paths", () => {
		expect(validatePatchPath("")).toMatchObject({ ok: false });
		expect(validatePatchPath("   ")).toMatchObject({ ok: false });
		expect(validatePatchPath("a\0b")).toMatchObject({ ok: false, reason: expect.stringContaining("NUL") });
	});

	it("rejects POSIX and Windows absolute paths", () => {
		expect(validatePatchPath("/etc/passwd")).toMatchObject({ ok: false, reason: expect.stringContaining("absolute") });
		expect(validatePatchPath("C:\\Windows\\system32")).toMatchObject({ ok: false });
		expect(validatePatchPath("C:/Windows")).toMatchObject({ ok: false });
		expect(validatePatchPath("\\\\server\\share")).toMatchObject({ ok: false });
	});

	it("rejects home expansion and parent traversal", () => {
		expect(validatePatchPath("~")).toMatchObject({ ok: false });
		expect(validatePatchPath("~/secrets")).toMatchObject({ ok: false });
		expect(validatePatchPath("../outside.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
		expect(validatePatchPath("a/../../b")).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
	});

	it("rejects backslash separators", () => {
		expect(validatePatchPath("src\\app.ts")).toMatchObject({ ok: false, reason: expect.stringContaining("separators") });
	});
});

describe("isWithinCwd (symlink-aware containment)", () => {
	it("accepts paths nested under cwd and the cwd itself", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-path-within-"));
		expect(await isWithinCwd(root, join(root, "a", "b.txt"))).toBe(true);
		expect(await isWithinCwd(root, root)).toBe(true);
	});

	it("rejects sibling and parent paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-path-out-"));
		expect(await isWithinCwd(root, join(root, "..", "sibling.txt"))).toBe(false);
	});

	it("rejects targets that escape cwd through a symlinked directory", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-path-symlink-"));
		const root = join(base, "root");
		const outside = join(base, "outside");
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		symlinkSync(outside, join(root, "link"));
		expect(await isWithinCwd(root, join(root, "link", "escaped.txt"))).toBe(false);
	});
});

describe("resolveClaudePath", () => {
	it("preserves Claude absolute, relative, home, and leading @ behavior", () => {
		const root = mkdtempSync(join(tmpdir(), "provider-claude-path-"));
		expect(resolveClaudePath(root, "src/a.txt")).toEqual({ ok: true, absolutePath: join(root, "src", "a.txt"), relativePath: "src/a.txt" });
		expect(resolveClaudePath(root, "@src/a.txt")).toEqual({ ok: true, absolutePath: join(root, "src", "a.txt"), relativePath: "src/a.txt" });
		expect(resolveClaudePath(root, "/tmp/provider-absolute.txt")).toEqual({ ok: true, absolutePath: "/tmp/provider-absolute.txt", relativePath: "/tmp/provider-absolute.txt" });
		expect(resolveClaudePath(root, "~/notes.txt")).toEqual({ ok: true, absolutePath: join(homedir(), "notes.txt"), relativePath: join(homedir(), "notes.txt") });
	});

	it("rejects NUL bytes before Node path APIs see them", () => {
		const root = mkdtempSync(join(tmpdir(), "provider-claude-nul-"));
		expect(resolveClaudePath(root, "a\0b")).toMatchObject({ ok: false, reason: expect.stringContaining("NUL") });
	});
});

describe("resolveGeminiPath", () => {
	it("allows relative paths and absolute paths under cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-gemini-path-"));
		expect(await resolveGeminiPath(root, "src/a.txt")).toEqual({ ok: true, absolutePath: join(root, "src", "a.txt"), relativePath: "src/a.txt" });
		expect(await resolveGeminiPath(root, join(root, "src", "a.txt"))).toEqual({ ok: true, absolutePath: join(root, "src", "a.txt"), relativePath: "src/a.txt" });
	});

	it("rejects absolute paths outside cwd", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-gemini-outside-"));
		const root = join(base, "root");
		const outside = join(base, "outside.txt");
		await mkdir(root, { recursive: true });
		expect(await resolveGeminiPath(root, outside)).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
	});

	it("rejects parent traversal and symlink escapes", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-gemini-symlink-"));
		const root = join(base, "root");
		const outside = join(base, "outside");
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		symlinkSync(outside, join(root, "link"));
		expect(await resolveGeminiPath(root, "../outside.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("parent") });
		expect(await resolveGeminiPath(root, "a/../b.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("parent") });
		expect(await resolveGeminiPath(root, "link/escape.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
	});
});

describe("resolveExistingDirectoryUnderCwd", () => {
	it("allows existing directories under cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-workdir-ok-"));
		await mkdir(join(root, "src"));
		expect(await resolveExistingDirectoryUnderCwd(root, "src")).toEqual({ ok: true, absolutePath: join(root, "src"), relativePath: "src" });
	});

	it("rejects missing paths, files, outside directories, and symlink escapes", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-workdir-bad-"));
		const root = join(base, "root");
		const outside = join(base, "outside");
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		writeFileSync(join(root, "file.txt"), "not a dir");
		symlinkSync(outside, join(root, "link"));

		expect(await resolveExistingDirectoryUnderCwd(root, "missing")).toMatchObject({ ok: false, reason: expect.stringContaining("does not exist") });
		expect(await resolveExistingDirectoryUnderCwd(root, "file.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("not a directory") });
		expect(await resolveExistingDirectoryUnderCwd(root, outside)).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
		expect(await resolveExistingDirectoryUnderCwd(root, "link")).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
	});
});

describe("resolveCodexImagePath", () => {
	it("allows absolute and relative read-only image paths and strips leading @", () => {
		const base = mkdtempSync(join(tmpdir(), "provider-codex-image-"));
		const root = join(base, "root");
		const outside = join(base, "outside.png");
		expect(resolveCodexImagePath(root, "image.png")).toEqual({ ok: true, absolutePath: join(root, "image.png"), relativePath: "image.png" });
		expect(resolveCodexImagePath(root, "@image.png")).toEqual({ ok: true, absolutePath: join(root, "image.png"), relativePath: "image.png" });
		expect(resolveCodexImagePath(root, outside)).toEqual({ ok: true, absolutePath: outside, relativePath: outside });
	});
});

describe("resolvePatchPath", () => {
	it("resolves a relative path to an absolute location under cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-resolve-patch-"));
		const result = await resolvePatchPath(root, "src/app.ts");
		expect(result).toEqual({ ok: true, absolutePath: join(root, "src", "app.ts"), relativePath: "src/app.ts" });
	});

	it("rejects absolute paths before touching the filesystem", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-resolve-abs-"));
		expect(await resolvePatchPath(root, "/etc/hosts")).toMatchObject({ ok: false });
	});

	it("rejects symlink escapes from inside cwd", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-resolve-symlink-"));
		const root = join(base, "root");
		const outside = join(base, "outside");
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		writeFileSync(join(outside, "target.txt"), "secret");
		symlinkSync(outside, join(root, "link"));
		expect(await resolvePatchPath(root, "link/target.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
	});
});
