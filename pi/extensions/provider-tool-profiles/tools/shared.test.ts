import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { applyPatch, editTextFile, multiEditTextFile, readTextFile, replaceExact } from "./shared";

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "provider-tool-profiles-"));
}

describe("provider tool adapters", () => {
	it("reads Claude-style 1-based offsets and Gemini-style 0-based offsets", async () => {
		const dir = await tempDir();
		try {
			await writeFile(path.join(dir, "sample.txt"), "a\nb\nc\n", "utf-8");
			expect(await readTextFile({
				cwd: dir,
				filePath: "sample.txt",
				offset: 2,
				limit: 1,
				offsetBase: 1,
				numberLines: true,
			})).toBe("2\tb");
			expect(await readTextFile({
				cwd: dir,
				filePath: "sample.txt",
				offset: 2,
				limit: 1,
				offsetBase: 0,
			})).toBe("c");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("enforces exact replacement counts", () => {
		expect(replaceExact({
			content: "x x",
			oldString: "x",
			newString: "y",
			expectedReplacements: 2,
		})).toEqual({ content: "y y", replacements: 2 });
		expect(() => replaceExact({
			content: "x x",
			oldString: "x",
			newString: "y",
		})).toThrow("appears 2 times");
	});

	it("applies single and multiple exact edits", async () => {
		const dir = await tempDir();
		try {
			await writeFile(path.join(dir, "sample.txt"), "one\ntwo\nthree\n", "utf-8");
			await editTextFile({
				cwd: dir,
				filePath: "sample.txt",
				oldString: "two",
				newString: "TWO",
			});
			await multiEditTextFile({
				cwd: dir,
				filePath: "sample.txt",
				edits: [
					{ old_string: "one", new_string: "ONE" },
					{ old_string: "three", new_string: "THREE" },
				],
			});
			expect(await readFile(path.join(dir, "sample.txt"), "utf-8")).toBe("ONE\nTWO\nTHREE\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("applies add, update, and delete patch operations", async () => {
		const dir = await tempDir();
		try {
			await writeFile(path.join(dir, "old.txt"), "hello\nworld\n", "utf-8");
			await writeFile(path.join(dir, "gone.txt"), "remove me", "utf-8");
			const changed = await applyPatch(dir, [
				"*** Begin Patch",
				"*** Add File: added.txt",
				"+new file",
				"*** Update File: old.txt",
				"@@",
				" hello",
				"-world",
				"+there",
				"*** Delete File: gone.txt",
				"*** End Patch",
			].join("\n"));

			expect(changed).toEqual(["added.txt", "old.txt", "gone.txt"]);
			expect(await readFile(path.join(dir, "added.txt"), "utf-8")).toBe("new file");
			expect(await readFile(path.join(dir, "old.txt"), "utf-8")).toBe("hello\nthere\n");
			await expect(readFile(path.join(dir, "gone.txt"), "utf-8")).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

