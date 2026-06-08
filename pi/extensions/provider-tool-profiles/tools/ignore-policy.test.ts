import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnoredPath, loadIgnoreHierarchy, parseIgnorePatterns, toRipgrepExcludeGlob } from "./ignore-policy";

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

	it("does not translate negated rules into ripgrep include globs", () => {
		const rules = parseIgnorePatterns("gemini", ["*.tmp", "!keep.tmp"]);

		expect(rules.rules.map(toRipgrepExcludeGlob)).toEqual(["**/*.tmp", undefined]);
	});
});
