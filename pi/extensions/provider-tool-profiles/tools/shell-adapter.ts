import type { ExtensionAPI } from "./pi-compat";
import { requireResolvedPath, resolveExistingDirectoryUnderCwd } from "./path";
import { textResult, truncateTextTail, unsupportedResult, type TextResultDetails, type ToolTextResult } from "./results";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export type ShellProvider = "claude" | "codex" | "gemini";

export interface CodexShellOptions {
	login?: unknown;
	sandboxPermissions?: unknown;
	justification?: unknown;
	prefixRule?: unknown;
}

export interface ProviderShellInput {
	pi: Pick<ExtensionAPI, "exec">;
	cwd: string;
	profile: ShellProvider;
	toolName: string;
	command: string;
	workdir?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
	runInBackground?: boolean;
	codex?: CodexShellOptions;
}

export interface ShellResultDetails extends TextResultDetails {
	profile: ShellProvider;
	toolName: string;
	cwd?: string;
	code?: number | null;
	timedOut?: boolean;
	aborted?: boolean;
	killed?: boolean;
	truncated?: boolean;
	unsupported?: true;
	denied?: true;
	unsupportedField?: string;
}

export function normalizeShellTimeout(timeoutMs: number | undefined): number {
	return Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
}

function hasMeaningfulValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return value !== undefined && value !== null && value !== false;
}

function unsupportedShellResult(message: string, details: ShellResultDetails): ToolTextResult<ShellResultDetails> {
	return unsupportedResult(message, details) as ToolTextResult<ShellResultDetails>;
}

function validateCodexShellOptions(input: ProviderShellInput): ToolTextResult<ShellResultDetails> | undefined {
	if (input.profile !== "codex") return undefined;
	const options = input.codex ?? {};
	if (options.sandboxPermissions === "require_escalated") {
		return unsupportedShellResult("Codex shell_command sandbox_permissions=require_escalated is not supported by provider-tool-profiles. Command was not executed.", {
			profile: input.profile,
			toolName: input.toolName,
			unsupportedField: "sandbox_permissions",
			denied: true,
		});
	}
	if (options.sandboxPermissions !== undefined && options.sandboxPermissions !== "use_default") {
		return unsupportedShellResult(`Codex shell_command sandbox_permissions=${String(options.sandboxPermissions)} is not supported. Command was not executed.`, {
			profile: input.profile,
			toolName: input.toolName,
			unsupportedField: "sandbox_permissions",
		});
	}
	if (hasMeaningfulValue(options.justification)) {
		return unsupportedShellResult("Codex shell_command justification is only meaningful with approval semantics, which provider-tool-profiles does not implement. Command was not executed.", {
			profile: input.profile,
			toolName: input.toolName,
			unsupportedField: "justification",
		});
	}
	if (hasMeaningfulValue(options.prefixRule)) {
		return unsupportedShellResult("Codex shell_command prefix_rule is only meaningful with approval semantics, which provider-tool-profiles does not implement. Command was not executed.", {
			profile: input.profile,
			toolName: input.toolName,
			unsupportedField: "prefix_rule",
		});
	}
	return undefined;
}

async function resolveShellCwd(input: ProviderShellInput): Promise<string> {
	if (input.workdir === undefined) return input.cwd;
	if (typeof input.workdir !== "string") throw new Error(`${input.profile === "gemini" ? "dir_path" : "workdir"}: expected string`);
	return requireResolvedPath(await resolveExistingDirectoryUnderCwd(input.cwd, input.workdir), input.profile === "gemini" ? "dir_path" : "workdir").absolutePath;
}

function shellArgs(input: ProviderShellInput): string[] {
	if (input.profile === "gemini") return ["-c", input.command];
	if (input.profile === "codex" && input.codex?.login === false) return ["-c", input.command];
	return ["-lc", input.command];
}

function formatShellOutput(stdout: string, stderr: string, code: number | null): string {
	const output = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
	const exit = `(exit ${code ?? "unknown"})`;
	return output ? `${output}${output.endsWith("\n") ? "" : "\n"}${exit}` : exit;
}

function abortedResult(input: ProviderShellInput): ToolTextResult<ShellResultDetails> {
	return textResult("Command aborted", {
		profile: input.profile,
		toolName: input.toolName,
		code: null,
		timedOut: false,
		aborted: true,
		killed: true,
		truncated: false,
	});
}

/**
 * Executes provider-native shell tools through Pi's public ExtensionAPI.exec.
 *
 * `createLocalBashOperations()` is public, but using it here would bypass
 * extension-level exec hooks and lose the stdout/stderr result shape. Keeping
 * Pi exec behind this adapter preserves current integration behavior while
 * making a future backend swap local to one file.
 */
export async function runProviderShell(input: ProviderShellInput): Promise<ToolTextResult<ShellResultDetails>> {
	if (input.runInBackground) {
		return unsupportedShellResult("run_in_background is not supported by provider-tool-profiles v1. Run a foreground command instead.", {
			profile: input.profile,
			toolName: input.toolName,
			unsupportedField: "run_in_background",
		});
	}
	const unsupported = validateCodexShellOptions(input);
	if (unsupported) return unsupported;
	if (input.signal?.aborted) return abortedResult(input);

	const cwd = await resolveShellCwd(input);
	const timeoutMs = normalizeShellTimeout(input.timeoutMs);
	const args = shellArgs(input);
	let timedOut = false;
	let aborted = false;
	const onAbort = () => { aborted = true; };
	const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
	timer.unref();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await input.pi.exec("bash", args, { cwd, timeout: timeoutMs, signal: input.signal });
		const output = formatShellOutput(result.stdout, result.stderr, result.code);
		const truncated = truncateTextTail(output, { continuationHint: "Run a narrower command to see less output." });
		return textResult(truncated.text, {
			profile: input.profile,
			toolName: input.toolName,
			cwd,
			code: result.code,
			timedOut: result.killed && timedOut,
			aborted: aborted || (result.killed && input.signal?.aborted === true),
			killed: result.killed,
			truncated: truncated.truncated,
		});
	} catch (error) {
		if (aborted || input.signal?.aborted) return abortedResult(input);
		throw error;
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}
