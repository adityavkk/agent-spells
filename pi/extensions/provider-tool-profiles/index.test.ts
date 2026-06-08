import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import providerToolProfilesExtension from "./index";
import { CLAUDE_TOOLS } from "./types";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function renderedText(component: { render(width: number): string[] }, width = 100): string {
	return component.render(width).join("\n");
}

function harness(model: { provider: string; id: string }) {
	const handlers = new Map<string, Function[]>();
	let activeTools = ["read", "bash", "edit", "write", "answer"];
	const registered: string[] = [];
	const tools = new Map<string, any>();
	const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		registerTool(tool: { name: string }) { registered.push(tool.name); tools.set(tool.name, tool); },
		on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		getActiveTools() { return activeTools; },
		setActiveTools(tools: string[]) { activeTools = tools; },
		async exec(command: string, args: string[], options: unknown) {
			execCalls.push({ command, args, options });
			return { stdout: "ok", stderr: "", code: 0, killed: false };
		},
		appendEntry(customType: string, data: unknown) { customEntries.push({ customType, data }); },
	} as any;
	const ctx = {
		cwd: "/tmp/provider-tool-profiles-index-test",
		model,
		modelRegistry: { find() {}, getAvailable() { return []; }, async getApiKeyAndHeaders() { return { ok: false, error: "none" }; } },
		sessionManager: { getBranch() { return []; } },
		hasUI: true,
		ui: {
			setStatus(key: string, value: string | undefined) { statusCalls.push({ key, value }); },
			notify() {},
		},
	} as any;
	providerToolProfilesExtension(pi);
	return { handlers, registered, tools, execCalls, statusCalls, customEntries, get activeTools() { return activeTools; }, ctx };
}

describe("providerToolProfilesExtension", () => {
	it("registers tools and switches active tools on session_start", async () => {
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		expect(h.registered).toContain("Bash");
		expect(h.registered).toContain("shell_command");
		expect(h.registered).toContain("run_shell_command");
		for (const handler of h.handlers.get("session_start") ?? []) await handler({}, h.ctx);
		expect(h.activeTools).toEqual([...CLAUDE_TOOLS, "answer"]);
		expect(h.statusCalls.at(-1)).toEqual({ key: "provider-tools", value: "tools:claude" });
	});

	it("appends profile prompt once", async () => {
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		for (const handler of h.handlers.get("session_start") ?? []) await handler({}, h.ctx);
		const handler = (h.handlers.get("before_agent_start") ?? [])[0]!;
		const first = await handler({ systemPrompt: "base" }, h.ctx);
		expect(first.systemPrompt).toContain("Provider tool profile: Claude");
		const second = await handler({ systemPrompt: first.systemPrompt }, h.ctx);
		expect(second).toBeUndefined();
	});

	it("does not switch tools inside pi-subagents children", async () => {
		const previous = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_SUBAGENT_CHILD = "1";
		try {
			const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
			for (const handler of h.handlers.get("session_start") ?? []) await handler({}, h.ctx);
			expect(h.activeTools).toEqual(["read", "bash", "edit", "write", "answer"]);
			expect(h.statusCalls.at(-1)).toEqual({ key: "provider-tools", value: undefined });

			const handler = (h.handlers.get("before_agent_start") ?? [])[0]!;
			expect(await handler({ systemPrompt: "base" }, h.ctx)).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previous;
		}
	});

	it("provider shell tools execute through pi.exec", async () => {
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		const signal = new AbortController().signal;
		const result = await h.tools.get("Bash").execute("1", { command: "pwd", timeout: 1234 }, signal, () => {}, h.ctx);
		expect(h.execCalls).toEqual([{ command: "bash", args: ["-lc", "pwd"], options: { cwd: h.ctx.cwd, timeout: 1234, signal } }]);
		expect(result.content[0]?.text).toContain("ok");
	});

	it("formats Claude reads and audits subsequent writes with read history", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-claude-read-"));
		writeFileSync(join(root, "note.txt"), "alpha\nbeta\ngamma\n");
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		h.ctx.cwd = root;

		const read = await h.tools.get("Read").execute("1", { file_path: "note.txt", offset: 1, limit: 2 }, undefined, () => {}, h.ctx);
		const write = await h.tools.get("Write").execute("2", { file_path: "note.txt", content: "updated\n" }, undefined, () => {}, h.ctx);

		expect(read.content[0]?.text).toContain("     1\talpha");
		expect(read.content[0]?.text).toContain("     2\tbeta");
		expect(read.details).toMatchObject({ offsetBase: 1, textFormat: "cat-n", mediaKind: "text" });
		expect(write.details).toMatchObject({ overwrote: true, readHistory: "fresh" });
	});

	it("reports stale read history on provider writes after external changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-read-stale-"));
		const path = join(root, "note.txt");
		writeFileSync(path, "alpha\n");
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		h.ctx.cwd = root;

		await h.tools.get("Read").execute("1", { file_path: "note.txt" }, undefined, () => {}, h.ctx);
		writeFileSync(path, "changed elsewhere\n");
		const write = await h.tools.get("Write").execute("2", { file_path: "note.txt", content: "updated\n" }, undefined, () => {}, h.ctx);

		expect(write.details).toMatchObject({ overwrote: true, readHistory: "stale" });
	});

	it("audits provider edits with read history", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-edit-read-history-"));
		writeFileSync(join(root, "note.txt"), "alpha\nbeta\n");
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		h.ctx.cwd = root;

		await h.tools.get("Read").execute("1", { file_path: "note.txt" }, undefined, () => {}, h.ctx);
		const edit = await h.tools.get("Edit").execute("2", { file_path: "note.txt", old_string: "beta", new_string: "BETA" }, undefined, () => {}, h.ctx);

		expect(edit.details).toMatchObject({ replacements: [1], readHistory: "fresh" });
	});

	it("keeps Gemini read_file plain and 0-based", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-gemini-read-"));
		writeFileSync(join(root, "note.txt"), "alpha\nbeta\ngamma\n");
		const h = harness({ provider: "google", id: "gemini-3-pro" });
		h.ctx.cwd = root;

		const result = await h.tools.get("read_file").execute("1", { file_path: "note.txt", offset: 1, limit: 1 }, undefined, () => {}, h.ctx);

		expect(result.content[0]?.text).toBe("beta\n\n[Showing lines 2-2 of 3. Use offset 2 to continue.]");
		expect(result.details).toMatchObject({ offsetBase: 0, textFormat: "plain", mediaKind: "text" });
	});

	it("returns explicit deferred media results from Gemini read_file", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-gemini-pdf-"));
		writeFileSync(join(root, "file.pdf"), "%PDF fake");
		const h = harness({ provider: "google", id: "gemini-3-pro" });
		h.ctx.cwd = root;

		const result = await h.tools.get("read_file").execute("1", { file_path: "file.pdf" }, undefined, () => {}, h.ctx);

		expect(result.content[0]?.text).toContain("PDF support is deferred");
		expect(result.details).toMatchObject({ unsupported: true, mediaKind: "PDF" });
	});

	it("enforces Gemini cwd containment before file mutation", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-gemini-tool-"));
		const root = join(base, "root");
		const outside = join(base, "outside.txt");
		mkdirSync(root);
		const h = harness({ provider: "google", id: "gemini-3-pro" });
		h.ctx.cwd = root;

		await expect(h.tools.get("write_file").execute("1", { file_path: outside, content: "nope" }, undefined, () => {}, h.ctx)).rejects.toThrow("escapes the working directory");

		expect(existsSync(outside)).toBe(false);
	});

	it("enforces Gemini shell dir_path as an existing directory under cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "provider-gemini-shell-"));
		writeFileSync(join(root, "file.txt"), "not a directory");
		const h = harness({ provider: "google", id: "gemini-3-pro" });
		h.ctx.cwd = root;

		await expect(h.tools.get("run_shell_command").execute("1", { command: "pwd", dir_path: "file.txt" }, undefined, () => {}, h.ctx)).rejects.toThrow("not a directory");

		expect(h.execCalls).toEqual([]);
	});

	it("denies Codex shell escalation and approval fields before exec", async () => {
		const h = harness({ provider: "openai-codex", id: "gpt-5.4" });

		const escalated = await h.tools.get("shell_command").execute("1", { command: "id", sandbox_permissions: "require_escalated", justification: "Need root" }, undefined, () => {}, h.ctx);
		const justified = await h.tools.get("shell_command").execute("2", { command: "git pull", justification: "Approve pull" }, undefined, () => {}, h.ctx);
		const prefixed = await h.tools.get("shell_command").execute("3", { command: "git pull", prefix_rule: ["git", "pull"] }, undefined, () => {}, h.ctx);

		expect(h.execCalls).toEqual([]);
		expect(escalated.details).toMatchObject({ unsupported: true, denied: true, unsupportedField: "sandbox_permissions" });
		expect(justified.details).toMatchObject({ unsupported: true, unsupportedField: "justification" });
		expect(prefixed.details).toMatchObject({ unsupported: true, unsupportedField: "prefix_rule" });
	});

	it("enforces Codex shell workdir containment before exec", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-codex-shell-"));
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		const h = harness({ provider: "openai-codex", id: "gpt-5.4" });
		h.ctx.cwd = root;

		await expect(h.tools.get("shell_command").execute("1", { command: "pwd", workdir: outside }, undefined, () => {}, h.ctx)).rejects.toThrow("escapes the working directory");

		expect(h.execCalls).toEqual([]);
	});

	it("persists Codex update_plan state as custom session entries", async () => {
		const h = harness({ provider: "openai-codex", id: "gpt-5.4" });

		const result = await h.tools.get("update_plan").execute("1", { explanation: "Tracking", plan: [{ step: "Implement", status: "in_progress" }] }, undefined, () => {}, h.ctx);

		expect(result.content[0]?.text).toContain("- [in_progress] Implement");
		expect(result.details).toMatchObject({ persisted: true, plan: [{ step: "Implement", status: "in_progress" }] });
		expect(h.customEntries).toHaveLength(1);
		expect(h.customEntries[0]?.customType).toBe("provider-tool-profiles.codex.plan.v1");
	});

	it("keeps Codex view_image read-only paths outside cwd available", async () => {
		const base = mkdtempSync(join(tmpdir(), "provider-codex-image-"));
		const root = join(base, "root");
		const outside = join(base, "outside.png");
		mkdirSync(root);
		writeFileSync(outside, "fake image bytes");
		const h = harness({ provider: "openai-codex", id: "gpt-5.4" });
		h.ctx.cwd = root;

		const result = await h.tools.get("view_image").execute("1", { path: outside }, undefined, () => {}, h.ctx);

		expect(result.content[0]?.text).toContain(`Loaded image ${outside}`);
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from("fake image bytes").toString("base64") });
	});

	it("renders long shell output compactly until expanded", () => {
		const h = harness({ provider: "openai-codex", id: "gpt-5.4" });
		const tool = h.tools.get("shell_command");
		const result = { content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") }], details: {} };
		const compact = renderedText(tool.renderResult(result, { expanded: false }, theme, { cwd: h.ctx.cwd, showImages: true }));
		const expanded = renderedText(tool.renderResult(result, { expanded: true }, theme, { cwd: h.ctx.cwd, showImages: true }));

		expect(compact.split("\n")).not.toContain("line 1");
		expect(compact).toContain("14 earlier lines");
		expect(compact).toContain("line 20");
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("line 20");
	});

	it("renders read output as summary unless expanded", () => {
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		const tool = h.tools.get("Read");
		const result = { content: [{ type: "text", text: "secret file body\nsecond line" }], details: { lineCount: 2, bytes: 28 } };
		const compact = renderedText(tool.renderResult(result, { expanded: false }, theme, { cwd: h.ctx.cwd, showImages: true }));
		const expanded = renderedText(tool.renderResult(result, { expanded: true }, theme, { cwd: h.ctx.cwd, showImages: true }));

		expect(compact).toContain("2 lines");
		expect(compact).toContain("28B");
		expect(compact).not.toContain("secret file body");
		expect(expanded).toContain("secret file body");
	});
});
