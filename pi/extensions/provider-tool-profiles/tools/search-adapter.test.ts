import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProviderGlob, runProviderGrep } from "./search-adapter";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-search-adapter-"));
}

function write(path: string, content: string, mtime: Date): void {
	writeFileSync(path, content);
	utimesSync(path, mtime, mtime);
}

describe("provider search adapter", () => {
	it("returns glob results newest-first with deterministic path ties", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "src"));
		write(join(root, "src", "old.ts"), "old", new Date("2024-01-01T00:00:00Z"));
		write(join(root, "src", "new.ts"), "new", new Date("2024-02-01T00:00:00Z"));
		write(join(root, "src", "same-a.ts"), "same", new Date("2024-03-01T00:00:00Z"));
		write(join(root, "src", "same-b.ts"), "same", new Date("2024-03-01T00:00:00Z"));

		const result = await runProviderGlob({ cwd: root, profile: "claude", toolName: "Glob", pattern: "src/*.ts" });

		expect(result.content[0]?.text.split("\n")).toEqual(["src/same-a.ts", "src/same-b.ts", "src/new.ts", "src/old.ts"]);
		expect(result.details).toMatchObject({ profile: "claude", toolName: "Glob", results: 4, capped: false });
	});

	it("applies Gemini cwd containment, case-insensitive globbing, and .geminiignore excludes", async () => {
		const base = tempRoot();
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(join(root, ".geminiignore"), "ignored.ts\n");
		writeFileSync(join(root, "MATCH.TS"), "match");
		writeFileSync(join(root, "ignored.ts"), "ignored");
		symlinkSync(outside, join(root, "escape"));

		const result = await runProviderGlob({ cwd: root, profile: "gemini", toolName: "glob", pattern: "*.ts", caseSensitive: false });

		expect(result.content[0]?.text).toBe("MATCH.TS");
		expect(result.details).toMatchObject({ profile: "gemini", geminiIgnoreRules: 1 });
		await expect(runProviderGlob({ cwd: root, profile: "gemini", toolName: "glob", pattern: "*", path: "escape" })).rejects.toThrow("escapes the working directory");
	});

	it("runs grep with stable path sorting, modes, offset, and head_limit", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "b.ts"), "needle b1\nneedle b2\n");
		writeFileSync(join(root, "src", "a.ts"), "needle a1\nneedle a2\n");

		const files = await runProviderGrep({ cwd: root, profile: "claude", toolName: "Grep", pattern: "needle", path: "src", outputMode: "files_with_matches" });
		const content = await runProviderGrep({ cwd: root, profile: "claude", toolName: "Grep", pattern: "needle", path: "src", outputMode: "content", headLimit: 2, offset: 1 });
		const none = await runProviderGrep({ cwd: root, profile: "claude", toolName: "Grep", pattern: "absent", path: "src", outputMode: "content" });

		expect(files.content[0]?.text.split("\n")).toEqual(["./a.ts", "./b.ts"]);
		expect(content.content[0]?.text.split("\n")).toEqual(["./a.ts:2:needle a2", "./b.ts:1:needle b1"]);
		expect(content.details).toMatchObject({ matches: 2, mode: "content" });
		expect(none.content[0]?.text).toBe("No matches found");
		expect(none.details).toMatchObject({ matches: 0 });
	});

	it("applies Gemini .geminiignore negations after ripgrep discovery", async () => {
		const root = tempRoot();
		writeFileSync(join(root, ".geminiignore"), "*.ts\n!keep.ts\n");
		writeFileSync(join(root, "drop.ts"), "needle drop\n");
		writeFileSync(join(root, "keep.ts"), "needle keep\n");

		const glob = await runProviderGlob({ cwd: root, profile: "gemini", toolName: "glob", pattern: "*.ts" });
		const grep = await runProviderGrep({ cwd: root, profile: "gemini", toolName: "grep_search", pattern: "needle", outputMode: "content", glob: "*.ts" });

		expect(glob.content[0]?.text).toBe("keep.ts");
		expect(grep.content[0]?.text).toBe("./keep.ts:1:needle keep");
		expect(grep.details).toMatchObject({ geminiIgnoreRules: 2, unsupportedGeminiIgnoreNegations: 0 });
	});

	it("filters Gemini grep results with colon-containing paths", async () => {
		const root = tempRoot();
		writeFileSync(join(root, ".geminiignore"), "drop:me.ts\n");
		writeFileSync(join(root, "drop:me.ts"), "needle drop\n");
		writeFileSync(join(root, "keep:me.ts"), "needle keep\n");

		const result = await runProviderGrep({ cwd: root, profile: "gemini", toolName: "grep_search", pattern: "needle", outputMode: "content", glob: "*.ts" });

		expect(result.content[0]?.text).toBe("./keep:me.ts:1:needle keep");
	});

	it("applies Gemini .geminiignore to grep", async () => {
		const root = tempRoot();
		writeFileSync(join(root, ".geminiignore"), "ignored.ts\n");
		writeFileSync(join(root, "kept.ts"), "needle kept\n");
		writeFileSync(join(root, "ignored.ts"), "needle ignored\n");

		const result = await runProviderGrep({ cwd: root, profile: "gemini", toolName: "grep_search", pattern: "needle", outputMode: "content", glob: "*.ts" });

		expect(result.content[0]?.text).toBe("./kept.ts:1:needle kept");
		expect(result.details).toMatchObject({ profile: "gemini", toolName: "grep_search", geminiIgnoreRules: 1 });
	});
});
