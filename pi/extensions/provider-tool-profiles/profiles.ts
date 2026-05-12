import type { ProviderToolProfileName } from "./types";

export const PI_CORE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export const CLAUDE_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS"] as const;
export const CODEX_TOOLS = ["shell_command", "apply_patch", "update_plan", "view_image"] as const;
export const GEMINI_TOOLS = [
	"run_shell_command",
	"read_file",
	"read_many_files",
	"list_directory",
	"glob",
	"grep_search",
	"search_file_content",
	"replace",
	"write_file",
] as const;

export const PROFILE_TOOLS: Record<ProviderToolProfileName, readonly string[]> = {
	claude: CLAUDE_TOOLS,
	codex: CODEX_TOOLS,
	gemini: GEMINI_TOOLS,
};

export const ALL_MANAGED_TOOLS = [
	...CLAUDE_TOOLS,
	...CODEX_TOOLS,
	...GEMINI_TOOLS,
];

export const PROFILE_PROMPTS: Record<ProviderToolProfileName, string> = {
	claude: "Tool profile: Claude Code-style core tools are active. Prefer exact string edits with Edit/MultiEdit and use absolute file paths when practical.",
	codex: "Tool profile: Codex CLI-style core tools are active. Prefer apply_patch for file edits, shell_command for shell work, update_plan for user-visible plans, and view_image for image inspection.",
	gemini: "Tool profile: Gemini CLI-style core tools are active. Prefer read_file/read_many_files for inspection, replace/write_file for edits, and run_shell_command for shell work.",
};

export function uniqueTools(tools: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tool of tools) {
		if (seen.has(tool)) continue;
		seen.add(tool);
		result.push(tool);
	}
	return result;
}

