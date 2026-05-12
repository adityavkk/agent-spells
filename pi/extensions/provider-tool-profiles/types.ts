import type { Model } from "@mariozechner/pi-ai";

export type ProviderToolProfileName = "claude" | "codex" | "gemini";

export interface ProviderProfileToggleConfig {
	claude: boolean;
	codex: boolean;
	gemini: boolean;
}

export interface ProviderToolProfilesConfig {
	enabled: boolean;
	profiles: ProviderProfileToggleConfig;
	fallbackTools: string[];
	modelMatchers: Partial<Record<ProviderToolProfileName, string[]>>;
}

export interface LoadedProviderToolProfilesConfig {
	globalPath: string;
	projectPath: string;
	globalConfig: ProviderToolProfilesConfig;
	projectConfig: ProviderToolProfilesConfig;
	mergedConfig: ProviderToolProfilesConfig;
	errors: Array<{ path: string; message: string }>;
}

export interface ProfileResolutionInput {
	model?: Model<any>;
	config?: ProviderToolProfilesConfig;
	env?: Record<string, string | undefined>;
}

export interface ToolActivationState {
	previousCoreTools?: string[];
	lastProfile?: ProviderToolProfileName;
}

