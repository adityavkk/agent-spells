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
import {
	MODEL_PROFILES_PROVIDER,
	type ModelProfilesConfig,
	type ModelProfilesState,
	type ModelRegistryLike,
	type ResolvedRoleResult,
} from "../model-profiles/types";
import type { RecapConfig } from "./types";

/** A live model-profiles selection parsed from a synthetic `profiles/<p>:<r>` model. */
export interface SyntheticProfileSelection {
	profile: string;
	role: string;
}

/**
 * Detect pi's synthetic `profiles/<profile>:<role>` model and parse its
 * selection. Local mirror of model-profiles/provider.ts
 * parseSyntheticProfileModelId/isSyntheticProfileModel (kept local because
 * provider.ts does not compile under this extension's strict tsconfig; the id
 * format is anchored to the shared MODEL_PROFILES_PROVIDER constant).
 *
 * Recap must never route completions through the synthetic provider — it
 * would mutate model-profiles' persisted fallback state — so callers use this
 * both to exclude the synthetic model as a fallback and to read the live
 * profile/role selection out of it.
 */
export function parseSyntheticProfileSelection(
	model: Pick<Model<any>, "provider" | "id"> | undefined,
): SyntheticProfileSelection | null {
	if (!model || model.provider !== MODEL_PROFILES_PROVIDER) return null;
	const separatorIndex = model.id.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex >= model.id.length - 1) return null;
	const profile = model.id.slice(0, separatorIndex).trim();
	const role = model.id.slice(separatorIndex + 1).trim();
	if (!profile || !role) return null;
	return { profile, role };
}

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
