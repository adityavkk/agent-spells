import type { Model } from "@mariozechner/pi-ai";
import { resolveModelRole } from "../model-profiles/resolve";
import type { ModelProfilesConfig, ModelProfilesState, ModelRegistryLike, ResolvedRoleResult } from "../model-profiles/types";
import type { RenderConfig } from "./config";

export const RENDER_INTERNAL_ROLE = "render";
export const DEFAULT_RENDER_MODEL_ROLE = "small";
export const DEFAULT_RENDER_FALLBACK_ROLE = "smol";
export const DEFAULT_RENDER_ROLE_CANDIDATES = [
	RENDER_INTERNAL_ROLE,
	DEFAULT_RENDER_MODEL_ROLE,
	DEFAULT_RENDER_FALLBACK_ROLE,
] as const;
export const DEFAULT_RENDER_E2E_PROFILE = "render-e2e";
export const DEFAULT_RENDER_E2E_ROLE = DEFAULT_RENDER_MODEL_ROLE;

function unique(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function getConfiguredProfile(config: ModelProfilesConfig, state: ModelProfilesState, renderConfig: RenderConfig): string | undefined {
	if (renderConfig.modelSelection.profile) return renderConfig.modelSelection.profile;
	if (renderConfig.modelSelection.useActiveProfile === false) return config.activeProfile;
	return state.activeProfile ?? config.activeProfile;
}

export function getRenderRoleCandidates(config: ModelProfilesConfig, state: ModelProfilesState = {}, renderConfig: RenderConfig = { modelSelection: {} }): string[] {
	const profileName = getConfiguredProfile(config, state, renderConfig);
	const profile = profileName ? config.profiles[profileName] : undefined;
	return unique([
		profileName ? renderConfig.modelSelection.rolesByProfile?.[profileName] : undefined,
		renderConfig.modelSelection.role,
		...(renderConfig.modelSelection.roleCandidates ?? DEFAULT_RENDER_ROLE_CANDIDATES),
		renderConfig.modelSelection.fallbackToActiveRole === false ? undefined : state.activeRole,
		renderConfig.modelSelection.fallbackToDefaultRole === false ? undefined : profile?.defaultRole,
	]);
}

export async function resolveRenderExtractionModel(input: {
	modelRegistry: ModelRegistryLike;
	config: ModelProfilesConfig;
	renderConfig?: RenderConfig;
	state?: ModelProfilesState;
	currentModel?: Model<any>;
}): Promise<ResolvedRoleResult | null> {
	const state = input.state ?? {};
	const renderConfig = input.renderConfig ?? { modelSelection: {} };
	const profileName = getConfiguredProfile(input.config, state, renderConfig);
	const profileSource = renderConfig.modelSelection.profile
		? "config"
		: state.activeProfile && renderConfig.modelSelection.useActiveProfile !== false
			? "session"
			: "config";
		
	for (const roleName of getRenderRoleCandidates(input.config, state, renderConfig)) {
		const resolved = await resolveModelRole({
			modelRegistry: input.modelRegistry,
			config: input.config,
			state,
			currentModel: input.currentModel,
			profile: profileName ? { value: profileName, source: profileSource } : undefined,
			role: { value: roleName, source: "config" },
			allowModelFallbacks: false,
		});
		if (resolved) return resolved;
	}

	return await resolveModelRole({
		modelRegistry: input.modelRegistry,
		config: input.config,
		state,
		currentModel: input.currentModel,
		profile: profileName ? { value: profileName, source: profileSource } : undefined,
	});
}

export function buildRenderTestProfilesConfig(includeLocalRole: boolean): ModelProfilesConfig {
	return {
		activeProfile: DEFAULT_RENDER_E2E_PROFILE,
		profiles: {
			[DEFAULT_RENDER_E2E_PROFILE]: {
				defaultRole: DEFAULT_RENDER_E2E_ROLE,
				roles: {
					[DEFAULT_RENDER_E2E_ROLE]: {
						provider: "openai-codex",
						model: "gpt-5.4-mini",
						thinkingLevel: "minimal",
						fallback: includeLocalRole ? ["workhorse", "smart", "local"] : ["workhorse", "smart"],
					},
					workhorse: {
						provider: "openai-codex",
						model: "gpt-5.4",
						thinkingLevel: "low",
						fallback: ["smart"],
					},
					smart: {
						provider: "openai",
						model: "gpt-5.4",
						thinkingLevel: "low",
					},
					...(includeLocalRole
						? {
							local: {
								provider: "ollama",
								model: "gemma4:e4b",
								thinkingLevel: "low",
							},
						}
						: {}),
				},
			},
		},
	};
}
