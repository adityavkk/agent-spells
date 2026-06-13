import type { Model } from "./tools/pi-compat";

export type ProviderToolProfile = "claude" | "codex" | "gemini";

export interface ModelLike extends Partial<Pick<Model<any>, "provider" | "id" | "api">> {
	provider?: string;
	id?: string;
	api?: string;
}

export interface ProfileMatcherConfig {
	providerIncludes?: string[];
	idIncludes?: string[];
	apiIncludes?: string[];
}

export interface ProviderToolProfilesConfig {
	enabled: boolean;
	preserveExtensionTools: boolean;
	fallbackTools: string[];
	profiles: Record<ProviderToolProfile, boolean>;
	matchers: Record<ProviderToolProfile, ProfileMatcherConfig>;
}

export interface LoadedProviderToolProfilesConfig {
	globalPath: string;
	projectPath: string;
	globalConfig: PartialProviderToolProfilesConfig;
	projectConfig: PartialProviderToolProfilesConfig;
	mergedConfig: ProviderToolProfilesConfig;
	errors: Array<{ path: string; message: string }>;
}

export type PartialProviderToolProfilesConfig = Partial<{
	enabled: boolean;
	preserveExtensionTools: boolean;
	fallbackTools: string[];
	profiles: Partial<Record<ProviderToolProfile, boolean>>;
	matchers: Partial<Record<ProviderToolProfile, ProfileMatcherConfig>>;
}>;

export const PROVIDER_TOOL_PROFILES_FILENAME = "provider-tool-profiles.json";
export const PROVIDER_TOOL_PROFILES_STATUS_KEY = "provider-tools";

export const PI_CORE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type PiCoreTool = (typeof PI_CORE_TOOLS)[number];

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

export const PROFILE_TOOLS: Record<ProviderToolProfile, readonly string[]> = {
	claude: CLAUDE_TOOLS,
	codex: CODEX_TOOLS,
	gemini: GEMINI_TOOLS,
};

/**
 * Capability-preserving translation from Pi's canonical core tools to each
 * provider's native spelling. Keep this table narrower than the vendored
 * schema set: a schema can be available without being safe to activate for a
 * canonical capability.
 */
export const PROFILE_TOOL_CAPABILITIES = {
	claude: {
		read: ["Read"],
		bash: ["Bash"],
		edit: ["Edit", "MultiEdit"],
		write: ["Write"],
		grep: ["Grep"],
		find: ["Glob"],
		ls: ["LS"],
	},
	codex: {
		// No dedicated safe Codex read wrapper is active yet. Preserve Pi's
		// canonical read rather than granting shell capability for read-only
		// roles. Dedicated Codex read/list tools are tracked separately in #6.
		read: ["read"],
		bash: ["shell_command"],
		edit: ["apply_patch"],
		write: ["apply_patch"],
		grep: ["shell_command"],
		find: ["shell_command"],
		ls: ["shell_command"],
	},
	gemini: {
		read: ["read_file", "read_many_files"],
		bash: ["run_shell_command"],
		edit: ["replace"],
		write: ["write_file"],
		grep: ["grep_search", "search_file_content"],
		find: ["glob"],
		ls: ["list_directory"],
	},
} as const satisfies Record<ProviderToolProfile, Record<PiCoreTool, readonly string[]>>;

export const ALL_MANAGED_TOOLS = [...CLAUDE_TOOLS, ...CODEX_TOOLS, ...GEMINI_TOOLS] as const;
