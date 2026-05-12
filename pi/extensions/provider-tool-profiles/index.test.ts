import { describe, expect, it } from "bun:test";
import providerToolProfilesExtension from "./index";
import { CLAUDE_TOOLS, CODEX_TOOLS, GEMINI_TOOLS } from "./profiles";

function buildHarness(model: { provider: string; id: string; api?: string }) {
	const handlers = new Map<string, Function[]>();
	const registeredTools: string[] = [];
	let activeTools = ["read", "bash", "edit", "write", "answer"];
	const statuses: Array<{ key: string; value: string | undefined }> = [];

	const pi = {
		registerTool(tool: { name: string }) {
			registeredTools.push(tool.name);
		},
		on(event: string, handler: Function) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools() {
			return activeTools;
		},
		async setActiveTools(tools: string[]) {
			activeTools = tools;
		},
		async exec() {
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as any;

	const ctx = {
		cwd: "/tmp/provider-tool-profiles-index-test",
		model,
		hasUI: true,
		ui: {
			notify() {},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
		},
	} as any;

	return { handlers, registeredTools, pi, ctx, statuses, get activeTools() { return activeTools; } };
}

describe("providerToolProfilesExtension", () => {
	it("registers all managed tools", () => {
		const harness = buildHarness({ provider: "anthropic", id: "claude-sonnet" });
		providerToolProfilesExtension(harness.pi);

		expect(harness.registeredTools).toEqual([
			...CLAUDE_TOOLS,
			...CODEX_TOOLS,
			...GEMINI_TOOLS,
		]);
	});

	it("activates a profile on session start and appends profile prompt guidance", async () => {
		const harness = buildHarness({ provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages" });
		providerToolProfilesExtension(harness.pi);

		for (const handler of harness.handlers.get("session_start") ?? []) {
			await handler({}, harness.ctx);
		}

		expect(harness.activeTools).toEqual([...CLAUDE_TOOLS, "answer"]);
		expect(harness.statuses.at(-1)).toEqual({ key: "provider-tools", value: "tools:claude" });

		const beforeAgentStart = harness.handlers.get("before_agent_start")?.[0];
		const result = await beforeAgentStart?.({ systemPrompt: "base" }, harness.ctx);
		expect(result.systemPrompt).toContain("Claude Code-style");
	});

	it("restores default tools when switching to an unknown model", async () => {
		const harness = buildHarness({ provider: "anthropic", id: "claude-sonnet" });
		providerToolProfilesExtension(harness.pi);

		for (const handler of harness.handlers.get("session_start") ?? []) {
			await handler({}, harness.ctx);
		}
		harness.ctx.model = { provider: "local", id: "unknown" };
		for (const handler of harness.handlers.get("model_select") ?? []) {
			await handler({ model: harness.ctx.model }, harness.ctx);
		}

		expect(harness.activeTools).toEqual(["read", "bash", "edit", "write", "answer"]);
		expect(harness.statuses.at(-1)).toEqual({ key: "provider-tools", value: undefined });
	});
});

