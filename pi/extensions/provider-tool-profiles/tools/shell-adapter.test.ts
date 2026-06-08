import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeShellTimeout, runProviderShell } from "./shell-adapter";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "provider-shell-adapter-"));
}

function mockPi(result: { stdout?: string; stderr?: string; code?: number; killed?: boolean } = {}) {
	const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
	return {
		calls,
		pi: {
			async exec(command: string, args: string[], options: unknown) {
				calls.push({ command, args, options });
				return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0, killed: result.killed ?? false };
			},
		},
	};
}

describe("provider shell adapter", () => {
	it("normalizes shell timeouts to Pi bounds", () => {
		expect(normalizeShellTimeout(undefined)).toBe(120_000);
		expect(normalizeShellTimeout(-1)).toBe(1);
		expect(normalizeShellTimeout(700_000)).toBe(600_000);
	});

	it("runs shell commands through Pi exec and returns nonzero exits as results", async () => {
		const root = tempRoot();
		const { pi, calls } = mockPi({ stderr: "failed", code: 2 });

		const result = await runProviderShell({ pi, cwd: root, profile: "claude", toolName: "Bash", command: "false", timeoutMs: 1234 });

		expect(calls).toEqual([{ command: "bash", args: ["-lc", "false"], options: { cwd: root, timeout: 1234, signal: undefined } }]);
		expect(result.content[0]?.text).toBe("failed\n(exit 2)");
		expect(result.details).toMatchObject({ profile: "claude", toolName: "Bash", cwd: root, code: 2, timedOut: false, aborted: false, killed: false });
	});

	it("uses provider-specific shell invocation shape", async () => {
		const root = tempRoot();
		const { pi, calls } = mockPi({ stdout: "ok\n" });

		await runProviderShell({ pi, cwd: root, profile: "gemini", toolName: "run_shell_command", command: "pwd" });
		await runProviderShell({ pi, cwd: root, profile: "codex", toolName: "shell_command", command: "pwd", codex: { login: false } });

		expect(calls.map((call) => call.args)).toEqual([["-c", "pwd"], ["-c", "pwd"]]);
	});

	it("resolves Codex and Gemini workdirs as existing directories under cwd", async () => {
		const base = tempRoot();
		const root = join(base, "root");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(join(root, "sub"));
		mkdirSync(outside);
		writeFileSync(join(root, "file.txt"), "not a directory");
		const { pi, calls } = mockPi({ stdout: "ok" });

		await runProviderShell({ pi, cwd: root, profile: "codex", toolName: "shell_command", command: "pwd", workdir: "sub" });
		await expect(runProviderShell({ pi, cwd: root, profile: "gemini", toolName: "run_shell_command", command: "pwd", workdir: "file.txt" })).rejects.toThrow("not a directory");
		await expect(runProviderShell({ pi, cwd: root, profile: "codex", toolName: "shell_command", command: "pwd", workdir: outside })).rejects.toThrow("escapes the working directory");

		expect(calls).toHaveLength(1);
		expect((calls[0]?.options as { cwd: string }).cwd).toBe(join(root, "sub"));
	});

	it("denies unsupported Codex approval and escalation fields before exec", async () => {
		const root = tempRoot();
		const cases = [
			{ codex: { sandboxPermissions: "require_escalated", justification: "Need root" }, field: "sandbox_permissions", denied: true },
			{ codex: { justification: "Approve this" }, field: "justification", denied: undefined },
			{ codex: { prefixRule: ["git", "pull"] }, field: "prefix_rule", denied: undefined },
		];

		for (const testCase of cases) {
			const { pi, calls } = mockPi({ stdout: "should not run" });
			const result = await runProviderShell({ pi, cwd: root, profile: "codex", toolName: "shell_command", command: "id", codex: testCase.codex });
			expect(calls).toEqual([]);
			expect(result.content[0]?.text).toContain("Command was not executed");
			expect(result.details).toMatchObject({ unsupported: true, unsupportedField: testCase.field });
			if (testCase.denied) expect(result.details).toMatchObject({ denied: true });
		}
	});

	it("does not invoke exec when already aborted", async () => {
		const root = tempRoot();
		const controller = new AbortController();
		controller.abort();
		const { pi, calls } = mockPi({ stdout: "should not run" });

		const result = await runProviderShell({ pi, cwd: root, profile: "claude", toolName: "Bash", command: "sleep 10", signal: controller.signal });

		expect(calls).toEqual([]);
		expect(result.content[0]?.text).toBe("Command aborted");
		expect(result.details).toMatchObject({ code: null, aborted: true, killed: true });
	});

	it("reports timeout and abort metadata from Pi exec", async () => {
		const root = tempRoot();
		const timed = {
			async exec() {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { stdout: "", stderr: "timed out", code: 143, killed: true };
			},
		};
		const timedResult = await runProviderShell({ pi: timed, cwd: root, profile: "claude", toolName: "Bash", command: "sleep 10", timeoutMs: 5 });
		expect(timedResult.details).toMatchObject({ timedOut: true, aborted: false, killed: true });

		const controller = new AbortController();
		const aborting = {
			async exec() {
				controller.abort();
				throw new Error("aborted by backend");
			},
		};
		const aborted = await runProviderShell({ pi: aborting, cwd: root, profile: "claude", toolName: "Bash", command: "sleep 10", signal: controller.signal });
		expect(aborted.details).toMatchObject({ timedOut: false, aborted: true, killed: true });
	});
});
