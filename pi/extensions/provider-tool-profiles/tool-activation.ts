import {
	ALL_MANAGED_TOOLS,
	PI_CORE_TOOLS,
	PROFILE_TOOLS,
	type ProviderToolProfile,
	type ProviderToolProfilesConfig,
} from "./types";

const managedTools = new Set<string>(ALL_MANAGED_TOOLS);
const piCoreTools = new Set<string>(PI_CORE_TOOLS);

export interface ToolActivationState {
	previousCoreTools?: string[];
	activeProfile?: ProviderToolProfile;
}

export interface ToolActivationResult {
	state: ToolActivationState;
	tools: string[];
	profile?: ProviderToolProfile;
}

function unique(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function coreToolsFrom(active: readonly string[]): string[] {
	return active.filter((tool) => piCoreTools.has(tool));
}

function preservedTools(active: readonly string[], config: ProviderToolProfilesConfig): string[] {
	if (!config.preserveExtensionTools) return [];
	return active.filter((tool) => !managedTools.has(tool) && !piCoreTools.has(tool));
}

export function buildProviderToolActivation(
	active: readonly string[],
	profile: ProviderToolProfile | undefined,
	config: ProviderToolProfilesConfig,
	state: ToolActivationState = {},
): ToolActivationResult {
	const nextState: ToolActivationState = { ...state };
	const preserved = preservedTools(active, config);

	if (profile) {
		if (!nextState.previousCoreTools) {
			const previousCore = coreToolsFrom(active);
			nextState.previousCoreTools = previousCore.length > 0 ? previousCore : config.fallbackTools;
		}
		nextState.activeProfile = profile;
		return {
			state: nextState,
			profile,
			tools: unique([...PROFILE_TOOLS[profile], ...preserved]),
		};
	}

	const restored = nextState.previousCoreTools?.length ? nextState.previousCoreTools : config.fallbackTools;
	nextState.activeProfile = undefined;
	return {
		state: nextState,
		tools: unique([...restored, ...preserved]),
	};
}

export function getProfilePromptAppendix(profile: ProviderToolProfile | undefined): string | undefined {
	if (!profile) return undefined;
	if (profile === "claude") {
		return "Provider tool profile: Claude. Use Bash, Read, Write, Edit, MultiEdit, Glob, Grep, and LS exactly as Claude Code-style tools. Prefer exact edits over shell rewrites.";
	}
	if (profile === "codex") {
		return "Provider tool profile: Codex. Use shell_command for shell work, apply_patch for file changes, update_plan for concise plans, and view_image for local images.";
	}
	return "Provider tool profile: Gemini. Use run_shell_command, read_file/read_many_files, list_directory, glob, grep_search/search_file_content, replace, and write_file in Gemini CLI style.";
}
