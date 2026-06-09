import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGeminiTools } from "./gemini";

type ToolHarness = {
	tools: Map<string, any>;
	ctx: { cwd: string };
	run(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
};

function harness(cwd: string): ToolHarness {
	const tools = new Map<string, any>();
	const pi = { registerTool(tool: any) { tools.set(tool.name, tool); } } as any;
	registerGeminiTools(pi);
	const ctx = { cwd };
	return {
		tools,
		ctx,
		run(name, params, signal) {
			return tools.get(name).execute("1", params, signal, () => {}, ctx);
		},
	};
}

describe("gemini read_many_files", () => {
	it("expands directory include paths into recursive globs", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-read-many-dir-"));
		mkdirSync(join(root, "docs", "nested"), { recursive: true });
		writeFileSync(join(root, "docs", "top.md"), "top\n");
		writeFileSync(join(root, "docs", "nested", "deep.md"), "deep\n");
		writeFileSync(join(root, "README.md"), "readme\n");

		const h = harness(root);
		const result = await h.run("read_many_files", { include: ["docs/", "README.md"] });
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("--- docs/top.md ---");
		expect(text).toContain("--- docs/nested/deep.md ---");
		expect(text).toContain("--- README.md ---");
		expect(result.details?.files).toEqual(expect.arrayContaining(["docs/top.md", "docs/nested/deep.md", "README.md"]));
	});

	it("honors file_filtering_options.respect_gemini_ignore", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-read-many-ignore-"));
		writeFileSync(join(root, ".geminiignore"), "secret.txt\n");
		writeFileSync(join(root, "secret.txt"), "classified\n");
		writeFileSync(join(root, "public.txt"), "public\n");

		const h = harness(root);
		const respected = await h.run("read_many_files", { include: ["*.txt"] });
		expect(respected.content[0]?.text).toContain("--- public.txt ---");
		expect(respected.content[0]?.text).not.toContain("classified");

		const bypassed = await h.run("read_many_files", { include: ["*.txt"], file_filtering_options: { respect_gemini_ignore: false } });
		expect(bypassed.content[0]?.text).toContain("--- secret.txt ---");
		expect(bypassed.content[0]?.text).toContain("classified");
	});

	it("aborts cooperatively when the signal is already aborted", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-read-many-abort-"));
		writeFileSync(join(root, "a.txt"), "a\n");

		const h = harness(root);
		await expect(h.run("read_many_files", { include: ["*.txt"] }, AbortSignal.abort())).rejects.toThrow("aborted");
	});
});
