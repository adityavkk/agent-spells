import type { Model } from "@mariozechner/pi-ai";
import {
	getExtensionRoleCandidates,
	resolveExtensionExtractionModel,
	type ExtensionModelSelectionConfig,
} from "../model-profiles/extension-resolver";
import type {
	ModelProfilesConfig,
	ModelProfilesState,
	ModelRegistryLike,
	ResolvedRoleResult,
} from "../model-profiles/types";
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

function selectionFromRenderConfig(renderConfig: RenderConfig | undefined): ExtensionModelSelectionConfig {
	return renderConfig?.modelSelection ?? {};
}

export function getRenderRoleCandidates(
	config: ModelProfilesConfig,
	state: ModelProfilesState = {},
	renderConfig: RenderConfig = { modelSelection: {} },
): string[] {
	return getExtensionRoleCandidates(
		config,
		state,
		selectionFromRenderConfig(renderConfig),
		DEFAULT_RENDER_ROLE_CANDIDATES,
	);
}

export async function resolveRenderExtractionModel(input: {
	modelRegistry: ModelRegistryLike;
	config: ModelProfilesConfig;
	renderConfig?: RenderConfig;
	state?: ModelProfilesState;
	currentModel?: Model<any>;
}): Promise<ResolvedRoleResult | null> {
	return await resolveExtensionExtractionModel({
		modelRegistry: input.modelRegistry,
		config: input.config,
		state: input.state,
		currentModel: input.currentModel,
		selection: selectionFromRenderConfig(input.renderConfig),
		defaultRoleCandidates: DEFAULT_RENDER_ROLE_CANDIDATES,
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
