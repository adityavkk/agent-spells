import { ALL_MANAGED_TOOLS, PI_CORE_TOOLS, PROFILE_TOOLS, uniqueTools } from "./profiles";
import type { ProviderToolProfileName, ProviderToolProfilesConfig, ToolActivationState } from "./types";

export function resolveActiveTools(input: {
	activeTools: string[];
	profile?: ProviderToolProfileName;
	config: ProviderToolProfilesConfig;
	state?: ToolActivationState;
}): { tools: string[]; state: ToolActivationState } {
	const managed = new Set([...ALL_MANAGED_TOOLS, ...PI_CORE_TOOLS]);
	const preserved = input.activeTools.filter((tool) => !managed.has(tool));
	const previousCoreTools = input.state?.previousCoreTools
		?? input.activeTools.filter((tool) => PI_CORE_TOOLS.includes(tool));

	if (!input.profile) {
		const fallback = previousCoreTools.length > 0 ? previousCoreTools : input.config.fallbackTools;
		return {
			tools: uniqueTools([...fallback, ...preserved]),
			state: { previousCoreTools, lastProfile: undefined },
		};
	}

	return {
		tools: uniqueTools([...PROFILE_TOOLS[input.profile], ...preserved]),
		state: { previousCoreTools, lastProfile: input.profile },
	};
}

