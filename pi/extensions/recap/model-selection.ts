/**
 * Recap model resolution through model-profiles.
 *
 * Role candidates are ["recap", "smol", "small"]: a dedicated `recap` role
 * wins when configured; otherwise the cheap `smol`/`small` roles apply. With
 * the repo author's active profile, `smol` resolves to wibey-anthropic
 * claude-haiku-4-5-20251001 — a Haiku-class background model, matching how
 * Claude Code routes its recap-style background work.
 */
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
import type { RecapConfig } from "./types";

export const RECAP_INTERNAL_ROLE = "recap";
export const DEFAULT_RECAP_MODEL_ROLE = "smol";
export const DEFAULT_RECAP_FALLBACK_ROLE = "small";
export const DEFAULT_RECAP_ROLE_CANDIDATES = [
	RECAP_INTERNAL_ROLE,
	DEFAULT_RECAP_MODEL_ROLE,
	DEFAULT_RECAP_FALLBACK_ROLE,
] as const;

function selectionFromRecapConfig(recapConfig: RecapConfig | undefined): ExtensionModelSelectionConfig {
	return recapConfig?.modelSelection ?? {};
}

export function getRecapRoleCandidates(
	config: ModelProfilesConfig,
	state: ModelProfilesState = {},
	recapConfig?: RecapConfig,
): string[] {
	return getExtensionRoleCandidates(
		config,
		state,
		selectionFromRecapConfig(recapConfig),
		DEFAULT_RECAP_ROLE_CANDIDATES,
	);
}

export async function resolveRecapModel(input: {
	modelRegistry: ModelRegistryLike;
	config: ModelProfilesConfig;
	recapConfig?: RecapConfig;
	state?: ModelProfilesState;
	currentModel?: Model<any>;
}): Promise<ResolvedRoleResult | null> {
	return await resolveExtensionExtractionModel({
		modelRegistry: input.modelRegistry,
		config: input.config,
		state: input.state,
		currentModel: input.currentModel,
		selection: selectionFromRecapConfig(input.recapConfig),
		defaultRoleCandidates: DEFAULT_RECAP_ROLE_CANDIDATES,
	});
}
