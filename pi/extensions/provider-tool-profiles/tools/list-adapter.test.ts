import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProviderDirectory } from "./list-adapter";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-list-adapter-"));
}

describe("provider list adapter", () => {
	it("lists directories first, files second, sorted, with explicit ignores", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "z-dir"));
		mkdirSync(join(root, "a-dir"));
		writeFileSync(join(root, "b.txt"), "b");
		writeFileSync(join(root, "a.log"), "a");

		const result = await listProviderDirectory({ cwd: root, profile: "claude", toolName: "LS", path: ".", ignore: ["*.log"] });

		expect(result.content[0]?.text.split("\n")).toEqual(["a-dir/", "z-dir/", "b.txt"]);
		expect(result.details).toMatchObject({ profile: "claude", toolName: "LS", entries: 4, shown: 3, ignored: 1 });
	});

	it("applies Gemini .gitignore, .geminiignore, explicit ignores, and cwd containment", async () => {
		const base = tempRoot();
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		mkdirSync(join(root, "kept-dir"));
		writeFileSync(join(root, ".gitignore"), "git.log\n");
		writeFileSync(join(root, ".geminiignore"), "gemini.log\n");
		writeFileSync(join(root, "git.log"), "git");
		writeFileSync(join(root, "gemini.log"), "gemini");
		writeFileSync(join(root, "explicit.log"), "explicit");
		writeFileSync(join(root, "kept.txt"), "kept");
		symlinkSync(outside, join(root, "escape"));

		const result = await listProviderDirectory({
			cwd: root,
			profile: "gemini",
			toolName: "list_directory",
			path: ".",
			ignore: ["explicit.log"],
		});

		expect(result.content[0]?.text.split("\n")).toEqual(["kept-dir/", ".geminiignore", ".gitignore", "escape", "kept.txt"]);
		expect(result.details).toMatchObject({ profile: "gemini", gitIgnoreRules: 1, geminiIgnoreRules: 1, ignored: 3 });
		await expect(listProviderDirectory({ cwd: root, profile: "gemini", toolName: "list_directory", path: "escape" })).rejects.toThrow("escapes the working directory");
	});

	it("can disable Gemini ignore files explicitly", async () => {
		const root = tempRoot();
		writeFileSync(join(root, ".gitignore"), "git.log\n");
		writeFileSync(join(root, ".geminiignore"), "gemini.log\n");
		writeFileSync(join(root, "git.log"), "git");
		writeFileSync(join(root, "gemini.log"), "gemini");

		const result = await listProviderDirectory({
			cwd: root,
			profile: "gemini",
			toolName: "list_directory",
			path: ".",
			fileFilteringOptions: { respect_git_ignore: false, respect_gemini_ignore: false },
		});

		expect(result.content[0]?.text.split("\n")).toEqual([".geminiignore", ".gitignore", "gemini.log", "git.log"]);
		expect(result.details).toMatchObject({ gitIgnoreRules: 0, geminiIgnoreRules: 0, ignored: 0 });
	});
});
