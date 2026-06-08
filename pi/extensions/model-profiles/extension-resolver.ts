/**
 * Generic role-based model resolver for extensions that need a "small" model
 * for structured extraction (answer, render, etc.).
 *
 * Mirrors the pattern previously implemented inline in render/model-selection.ts.
 * Each extension can supply:
 *   - its own modelSelection config (loaded from `<ext>.json`)
 *   - a list of default role candidates ([\"small\", \"smol\", ...])
 * and gets back a `ResolvedRoleResult` with multiple candidates suitable for
 * `completeWithModelRoleFallback`.
 *
 * Important: this resolver intentionally walks role candidates with
 * `allowModelFallbacks: false` so a missing role does NOT silently fall through
 * to the active profile's defaultRole (which is typically a heavy `smart` model).
 */
import type { Model } from "@mariozechner/pi-ai";
import { resolveModelRole } from "./resolve";
import type {
	ModelProfilesConfig,
	ModelProfilesState,
	ModelRegistryLike,
	ModelRoleConfigTarget,
	ResolvedRoleResult,
} from "./types";

export interface ExtensionModelSelectionConfig {
	/** Force a specific profile, regardless of session state / config.activeProfile. */
	profile?: string;
	/** Force a specific role inside the resolved profile. */
	role?: string;
	/** Per-profile role override map. */
	rolesByProfile?: Record<string, string>;
	/** Ordered role candidates to try when nothing more specific matches. */
	roleCandidates?: string[];
	/** When false, ignore `state.activeProfile` and use `config.activeProfile`. */
	useActiveProfile?: boolean;
	/** When false, do not append `state.activeRole` to the candidate list. */
	fallbackToActiveRole?: boolean;
	/** When false, do not append the resolved profile's `defaultRole`. */
	fallbackToDefaultRole?: boolean;
	/** Direct concrete target (legacy single-target shape). */
	provider?: string;
	model?: string;
	thinkingLevel?: ModelRoleConfigTarget["thinkingLevel"];
	/** Direct ordered target list. Wins over role resolution when set. */
	targets?: ModelRoleConfigTarget[];
	/** Per-profile direct target lists. */
	targetsByProfile?: Record<string, ModelRoleConfigTarget[]>;
}

export interface ExtensionResolutionInput {
	modelRegistry: ModelRegistryLike;
	config: ModelProfilesConfig;
	selection?: ExtensionModelSelectionConfig;
	state?: ModelProfilesState;
	currentModel?: Model<any>;
	/**
	 * Default ordered role candidates for the extension when neither
	 * `selection.role` nor `selection.roleCandidates` is set. e.g. answer
	 * uses [\"small\", \"smol\"]; render uses [\"render\", \"small\", \"smol\"].
	 */
	defaultRoleCandidates: readonly string[];
}

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

function getConfiguredProfile(
	config: ModelProfilesConfig,
	state: ModelProfilesState,
	selection: ExtensionModelSelectionConfig,
): string | undefined {
	if (selection.profile) return selection.profile;
	if (selection.useActiveProfile === false) return config.activeProfile;
	return state.activeProfile ?? config.activeProfile;
}

function getDirectTargets(
	selection: ExtensionModelSelectionConfig,
	profileName: string | undefined,
): ModelRoleConfigTarget[] {
	const byProfile = profileName ? selection.targetsByProfile?.[profileName] : undefined;
	if (byProfile && byProfile.length > 0) return byProfile;
	if (selection.targets && selection.targets.length > 0) return selection.targets;
	if (selection.provider && selection.model) {
		return [{
			provider: selection.provider,
			model: selection.model,
			thinkingLevel: selection.thinkingLevel,
		}];
	}
	return [];
}

async function resolveDirectTargets(input: {
	modelRegistry: ModelRegistryLike;
	targets: ModelRoleConfigTarget[];
	profileName?: string;
}): Promise<ResolvedRoleResult | null> {
	const trace: string[] = [];
	const candidates = [];
	for (const [index, target] of input.targets.entries()) {
		if (!target.provider || !target.model) continue;
		const model = input.modelRegistry.find(target.provider, target.model);
		if (!model) {
			trace.push(`direct target ${index + 1} ${target.provider}/${target.model} not found in registry`);
			continue;
		}
		const auth = await input.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			trace.push(`direct target ${index + 1} ${target.provider}/${target.model} auth unavailable: ${auth.error}`);
			continue;
		}
		trace.push(`direct target ${index + 1} resolved to ${target.provider}/${target.model}`);
		candidates.push({
			model,
			ref: {
				provider: target.provider,
				model: target.model,
				thinkingLevel: target.thinkingLevel,
			},
		});
	}
	if (candidates.length === 0) return null;
	const primary = candidates[0]!;
	return {
		model: primary.model,
		ref: primary.ref,
		thinkingLevel: primary.ref.thinkingLevel,
		profile: input.profileName,
		source: "config",
		trace,
		candidates,
	};
}

export function getExtensionRoleCandidates(
	config: ModelProfilesConfig,
	state: ModelProfilesState = {},
	selection: ExtensionModelSelectionConfig = {},
	defaults: readonly string[] = [],
): string[] {
	const profileName = getConfiguredProfile(config, state, selection);
	const profile = profileName ? config.profiles[profileName] : undefined;
	return unique([
		profileName ? selection.rolesByProfile?.[profileName] : undefined,
		selection.role,
		...(selection.roleCandidates ?? defaults),
		selection.fallbackToActiveRole === false ? undefined : state.activeRole,
		selection.fallbackToDefaultRole === false ? undefined : profile?.defaultRole,
	]);
}

/**
 * Resolve a small/extraction model for an extension.
 *
 * Resolution order:
 *   1. Direct `targets` / `targetsByProfile` / `provider+model` (config-driven).
 *   2. Walk `roleCandidates` (with profile context, allowModelFallbacks: false)
 *      so each candidate role is matched against the active profile only.
 *   3. As a last resort, call `resolveModelRole` with full fallback (current
 *      session model, then first available model).
 */
export async function resolveExtensionExtractionModel(
	input: ExtensionResolutionInput,
): Promise<ResolvedRoleResult | null> {
	const state = input.state ?? {};
	const selection = input.selection ?? {};
	const profileName = getConfiguredProfile(input.config, state, selection);
	const profileSource = selection.profile
		? "config"
		: state.activeProfile && selection.useActiveProfile !== false
			? "session"
			: "config";

	const directTargets = getDirectTargets(selection, profileName);
	if (directTargets.length > 0) {
		const direct = await resolveDirectTargets({
			modelRegistry: input.modelRegistry,
			targets: directTargets,
			profileName,
		});
		if (direct) return direct;
	}

	const candidates = getExtensionRoleCandidates(input.config, state, selection, input.defaultRoleCandidates);
	for (const roleName of candidates) {
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
