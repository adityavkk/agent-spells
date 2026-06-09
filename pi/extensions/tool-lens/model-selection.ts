/**
 * Resolve a cheap/fast analyzer model for tool-lens, reusing the shared
 * model-profiles extension resolver. Mirrors render/model-selection: explicit
 * provider/model and `targets` win, then cheap role candidates (`tool-lens`,
 * `smol`) are tried with model fallbacks disabled so a missing role does not
 * silently escalate to a heavy default model.
 */
import type { Model } from "@mariozechner/pi-ai";
import {
	resolveExtensionExtractionModel,
	type ExtensionModelSelectionConfig,
} from "../model-profiles/extension-resolver";
import type {
	ModelProfilesConfig,
	ModelProfilesState,
	ModelRegistryLike,
	ResolvedRoleResult,
} from "../model-profiles/types";
import type { ToolLensConfig } from "./types";

export const TOOL_LENS_INTERNAL_ROLE = "tool-lens";
export const TOOL_LENS_FALLBACK_ROLE = "smol";
export const DEFAULT_TOOL_LENS_ROLE_CANDIDATES = [TOOL_LENS_INTERNAL_ROLE, TOOL_LENS_FALLBACK_ROLE] as const;

function selectionFromConfig(config: ToolLensConfig["modelSelection"]): ExtensionModelSelectionConfig {
	return config ?? {};
}

export async function resolveToolLensModel(input: {
	modelRegistry: ModelRegistryLike;
	config: ModelProfilesConfig;
	toolLensConfig: ToolLensConfig;
	state?: ModelProfilesState;
	currentModel?: Model<any>;
}): Promise<ResolvedRoleResult | null> {
	return await resolveExtensionExtractionModel({
		modelRegistry: input.modelRegistry,
		config: input.config,
		state: input.state,
		currentModel: input.currentModel,
		selection: selectionFromConfig(input.toolLensConfig.modelSelection),
		defaultRoleCandidates: DEFAULT_TOOL_LENS_ROLE_CANDIDATES,
	});
}
