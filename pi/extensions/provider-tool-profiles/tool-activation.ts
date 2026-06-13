import {
	ALL_MANAGED_TOOLS,
	PI_CORE_TOOLS,
	PROFILE_TOOL_CAPABILITIES,
	type PiCoreTool,
	type ProviderToolProfile,
	type ProviderToolProfilesConfig,
} from "./types";

const managedTools = new Set<string>(ALL_MANAGED_TOOLS);
const piCoreTools = new Set<string>(PI_CORE_TOOLS);
const PROFILE_PROMPT_APPENDIX_PREFIX = "Provider tool profile:";

export interface ToolActivationState {
	previousCoreTools?: string[];
	activeProfile?: ProviderToolProfile;
}

export interface ToolActivationResult {
	state: ToolActivationState;
	tools: string[];
	profileTools: string[];
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

function isPiCoreTool(tool: string): tool is PiCoreTool {
	return piCoreTools.has(tool);
}

function preservedTools(active: readonly string[], config: ProviderToolProfilesConfig): string[] {
	if (!config.preserveExtensionTools) return [];
	return active.filter((tool) => !managedTools.has(tool) && !piCoreTools.has(tool));
}

/**
 * Pure capability mapper. It consumes the canonical Pi tools captured before
 * provider activation and returns only the tools needed to represent those
 * capabilities for the selected provider.
 */
export function toolsForCanonicalCapabilities(profile: ProviderToolProfile, canonicalTools: readonly string[]): string[] {
	const capabilities = PROFILE_TOOL_CAPABILITIES[profile];
	return unique(canonicalTools.flatMap((tool) => (isPiCoreTool(tool) ? capabilities[tool] : [])));
}

function profileManagedTools(profile: ProviderToolProfile, tools: readonly string[]): string[] {
	const capabilities = PROFILE_TOOL_CAPABILITIES[profile];
	const profileTools = new Set<string>(PI_CORE_TOOLS.flatMap((tool) => capabilities[tool]));
	return tools.filter((tool) => managedTools.has(tool) && profileTools.has(tool));
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
		const canonicalTools = nextState.previousCoreTools ?? config.fallbackTools;
		nextState.previousCoreTools = canonicalTools;
		const mappedTools = toolsForCanonicalCapabilities(profile, canonicalTools);
		return {
			state: nextState,
			profile,
			tools: unique([...mappedTools, ...preserved]),
			profileTools: profileManagedTools(profile, mappedTools),
		};
	}

	const restored = nextState.previousCoreTools?.length ? nextState.previousCoreTools : config.fallbackTools;
	nextState.activeProfile = undefined;
	return {
		state: nextState,
		tools: unique([...restored, ...preserved]),
		profileTools: [],
	};
}

export function getProfilePromptAppendix(profile: ProviderToolProfile | undefined, profileTools: readonly string[] = []): string | undefined {
	if (!profile) return undefined;
	if (profileTools.length === 0) return undefined;
	const activeList = profileTools.join(", ");
	if (profile === "claude") {
		return `Provider tool profile: Claude. Active provider tools: ${activeList}. Use only available Claude Code-style tools, and prefer exact edits over shell rewrites when edit tools are available.`;
	}
	if (profile === "codex") {
		return `Provider tool profile: Codex. Active provider tools: ${activeList}. Use only available Codex-style tools; shell_command is present only when the original Pi tool surface included shell, search, find, or list capability.`;
	}
	return `Provider tool profile: Gemini. Active provider tools: ${activeList}. Use only available Gemini CLI-style tools.`;
}

function withoutProfilePromptAppendix(systemPrompt: string): string {
	return systemPrompt
		.split("\n\n")
		.filter((section) => !section.startsWith(PROFILE_PROMPT_APPENDIX_PREFIX))
		.join("\n\n");
}

export function applyProfilePromptAppendix(
	systemPrompt: string,
	profile: ProviderToolProfile | undefined,
	profileTools: readonly string[] = [],
): string | undefined {
	const appendix = getProfilePromptAppendix(profile, profileTools);
	const stripped = withoutProfilePromptAppendix(systemPrompt);
	if (!appendix) return stripped === systemPrompt ? undefined : stripped;
	const next = stripped ? `${stripped}\n\n${appendix}` : appendix;
	return next === systemPrompt ? undefined : next;
}
