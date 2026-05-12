import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExactEdits, applyExactEditsToText, readTextFile, resolveToolPath, runShell, writeTextFile } from "./shared";

describe("provider tool shared file adapters", () => {
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

	it("reads, writes, and edits files through resolved paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-tools-"));
		mkdirSync(join(root, "src"));
		const path = resolveToolPath(root, "src/a.txt");
		await writeTextFile(path, "a\nb\nc\n");
		expect(readFileSync(path, "utf8")).toBe("a\nb\nc\n");
		const read = await readTextFile(path, { offset: 1, limit: 1, offsetBase: 0 });
		expect(read.content[0]?.text).toBe("b");
		await applyExactEdits(path, [{ old_string: "b", new_string: "B" }]);
		expect(readFileSync(path, "utf8")).toBe("a\nB\nc\n");
	});

	it("routes shell commands through pi.exec", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-shell-"));
		const signal = new AbortController().signal;
		const calls: unknown[] = [];
		const pi = {
			async exec(command: string, args: string[], options: unknown) {
				calls.push({ command, args, options });
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			},
		};

		const result = await runShell({ pi, ctx: { cwd: root }, command: "echo ok", workdir: ".", timeoutMs: 1000, signal });

		expect(calls).toEqual([{ command: "bash", args: ["-lc", "echo ok"], options: { cwd: root, timeout: 1000, signal } }]);
		expect(result.content[0]?.text).toContain("ok");
		expect(result.content[0]?.text).toContain("(exit 0)");
		expect(result.details).toMatchObject({ code: 0, timedOut: false, aborted: false, killed: false });
	});

	it("surfaces aborts from pi.exec", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-shell-abort-"));
		const controller = new AbortController();
		const calls: unknown[] = [];
		const pi = {
			async exec(command: string, args: string[], options: unknown) {
				calls.push({ command, args, options });
				controller.abort();
				return { stdout: "", stderr: "aborted", code: 1, killed: true };
			},
		};

		const result = await runShell({ pi, ctx: { cwd: root }, command: "sleep 10", signal: controller.signal });

		expect(calls).toEqual([{ command: "bash", args: ["-lc", "sleep 10"], options: { cwd: root, timeout: 120000, signal: controller.signal } }]);
		expect(result.details).toMatchObject({ code: 1, aborted: true, killed: true });
	});
});
