import { describe, expect, it } from "bun:test";
import providerToolProfilesExtension from "./index";
import { CLAUDE_TOOLS } from "./types";

function harness(model: { provider: string; id: string }) {
	const handlers = new Map<string, Function[]>();
	let activeTools = ["read", "bash", "edit", "write", "answer"];
	const registered: string[] = [];
	const tools = new Map<string, any>();
	const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const pi = {
		registerTool(tool: { name: string }) { registered.push(tool.name); tools.set(tool.name, tool); },
		on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		getActiveTools() { return activeTools; },
		setActiveTools(tools: string[]) { activeTools = tools; },
		async exec(command: string, args: string[], options: unknown) {
			execCalls.push({ command, args, options });
			return { stdout: "ok", stderr: "", code: 0, killed: false };
		},
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
	return { handlers, registered, tools, execCalls, statusCalls, get activeTools() { return activeTools; }, ctx };
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

	it("provider shell tools execute through pi.exec", async () => {
		const h = harness({ provider: "anthropic", id: "claude-sonnet-4" });
		const signal = new AbortController().signal;
		const result = await h.tools.get("Bash").execute("1", { command: "pwd", timeout: 1234 }, signal, () => {}, h.ctx);
		expect(h.execCalls).toEqual([{ command: "bash", args: ["-lc", "pwd"], options: { cwd: h.ctx.cwd, timeout: 1234, signal } }]);
		expect(result.content[0]?.text).toContain("ok");
	});
});
