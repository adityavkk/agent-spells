import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnoredPath, loadIgnoreHierarchy, loadIgnoreTree, parseIgnorePatterns, toRipgrepExcludeGlob } from "./ignore-policy";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-ignore-policy-"));
}

describe("provider ignore policy", () => {
	it("applies ordered negations without marking them unsupported", () => {
		const rules = parseIgnorePatterns("gemini", ["*.log", "!keep.log"]);

		expect(isIgnoredPath("drop.log", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("keep.log", false, rules.rules)).toBe(false);
		expect(rules.negatedRules).toBe(1);
		expect(rules.unsupportedNegations).toBe(0);
	});

	it("supports anchored, directory-only, escaped, and scoped nested rules", () => {
		const rules = parseIgnorePatterns("git", ["/root.log", "cache/", "\\#literal", "docs/*.tmp"], "pkg");

		expect(isIgnoredPath("pkg/root.log", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("pkg/nested/root.log", false, rules.rules)).toBe(false);
		expect(isIgnoredPath("pkg/cache/file.txt", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("pkg/#literal", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("pkg/docs/a.tmp", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("pkg/other/a.tmp", false, rules.rules)).toBe(false);
	});

	it("loads ignore files from cwd through the listed directory", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "src", "nested"), { recursive: true });
		writeFileSync(join(root, ".geminiignore"), "root.log\n");
		writeFileSync(join(root, "src", ".geminiignore"), "nested.log\n!keep.log\n");

		const rules = await loadIgnoreHierarchy(root, join(root, "src", "nested"), ".geminiignore", "gemini");

		expect(isIgnoredPath("src/nested/root.log", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("src/nested/nested.log", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("src/nested/keep.log", false, rules.rules)).toBe(false);
	});

	it("loads scoped ignore files recursively and prunes ignored directories", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "src", "nested"), { recursive: true });
		mkdirSync(join(root, "ignored", "nested"), { recursive: true });
		writeFileSync(join(root, ".geminiignore"), "ignored/\n");
		writeFileSync(join(root, "src", ".geminiignore"), "*.tmp\n!keep.tmp\n");
		writeFileSync(join(root, "ignored", ".geminiignore"), "!nested/keep.tmp\n");

		const result = await loadIgnoreTree(root, root, ".geminiignore", "gemini");

		expect(isIgnoredPath("src/drop.tmp", false, result.rules.rules)).toBe(true);
		expect(isIgnoredPath("src/keep.tmp", false, result.rules.rules)).toBe(false);
		expect(isIgnoredPath("ignored/nested/keep.tmp", false, result.rules.rules)).toBe(true);
		expect(result.truncated).toBe(false);
	});

	it("supports globstar patterns matching direct and nested descendants", () => {
		const rules = parseIgnorePatterns("gemini", ["docs/**/*.tmp"]);

		expect(isIgnoredPath("docs/direct.tmp", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("docs/nested/deep.tmp", false, rules.rules)).toBe(true);
		expect(isIgnoredPath("other/direct.tmp", false, rules.rules)).toBe(false);
	});

	it("does not translate negated rules into ripgrep include globs", () => {
		const rules = parseIgnorePatterns("gemini", ["*.tmp", "!keep.tmp"]);

		expect(rules.rules.map(toRipgrepExcludeGlob)).toEqual(["**/*.tmp", undefined]);
	});
});
