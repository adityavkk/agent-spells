import type { Model } from "@mariozechner/pi-ai";

export const MODEL_PROFILES_FILENAME = "model-profiles.json";
export const MODEL_PROFILES_STATE_CUSTOM_TYPE = "model-profiles-state";

export type ModelProfilesThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelProfileName = string;
export type ModelRoleName = string;
export type ResolutionSource = "flag" | "env" | "session" | "config" | "current-model" | "first-available";

export interface ResolvedModelRef {
	provider: string;
	model: string;
	thinkingLevel?: ModelProfilesThinkingLevel;
}

export interface ModelRoleConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: ModelProfilesThinkingLevel;
	fallback?: string[];
}

export interface ModelProfileConfig {
	defaultRole?: string;
	roles: Record<ModelRoleName, ModelRoleConfig>;
}

export interface ModelProfilesConfig {
	activeProfile?: ModelProfileName;
	profiles: Record<ModelProfileName, ModelProfileConfig>;
}

export interface ModelProfilesState {
	activeProfile?: ModelProfileName;
	activeRole?: ModelRoleName;
}

export interface ModelProfilesConfigError {
	path: string;
	message: string;
}

export interface LoadedModelProfilesConfig {
	globalPath: string;
	projectPath: string;
	globalConfig: ModelProfilesConfig;
	projectConfig: ModelProfilesConfig;
	mergedConfig: ModelProfilesConfig;
	errors: ModelProfilesConfigError[];
}

export interface ModelProfilesSelection {
	value?: string;
	source?: Exclude<ResolutionSource, "current-model" | "first-available">;
}

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface ModelRegistryAuthResult {
	ok: true;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ModelRegistryAuthError {
	ok: false;
	error: string;
}

export type ModelRegistryResolvedAuth = ModelRegistryAuthResult | ModelRegistryAuthError;

export interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<any> | undefined;
	getAvailable(): Promise<Model<any>[]> | Model<any>[];
	getApiKeyAndHeaders(model: Model<any>): Promise<ModelRegistryResolvedAuth>;
}

export interface ResolveModelRoleInput {
	modelRegistry: ModelRegistryLike;
	config?: ModelProfilesConfig;
	state?: ModelProfilesState;
	currentModel?: Model<any>;
	profile?: ModelProfilesSelection;
	role?: ModelProfilesSelection;
	env?: Record<string, string | undefined>;
}

export interface ResolvedRoleResult {
	model: Model<any>;
	ref: ResolvedModelRef;
	thinkingLevel?: ModelProfilesThinkingLevel;
	profile?: string;
	role?: string;
	matchedRole?: string;
	source: ResolutionSource;
	trace: string[];
}
