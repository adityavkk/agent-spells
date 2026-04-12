import type { Model } from "@mariozechner/pi-ai";
import { normalizeModelProfilesState } from "./config";
import {
	MODEL_PROFILES_STATE_CUSTOM_TYPE,
	type ModelProfileConfig,
	type ModelProfilesConfig,
	type ModelProfilesSelection,
	type ModelProfilesState,
	type ModelRoleConfig,
	type ResolvedRoleCandidate,
	type ResolutionSource,
	type ResolveModelRoleInput,
	type ResolvedModelRef,
	type ResolvedRoleResult,
	type SessionEntryLike,
} from "./types";

function modelLabel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function pushTrace(trace: string[], message: string): void {
	trace.push(message);
}

function chooseSource(...sources: Array<ResolutionSource | undefined>): ResolutionSource {
	for (const source of sources) {
		if (source) return source;
	}
	return "config";
}

function getSelectionValue(
	explicitSelection: ModelProfilesSelection | undefined,
	envValue: string | undefined,
	sessionValue: string | undefined,
	configValue: string | undefined,
): { value?: string; source?: Exclude<ResolutionSource, "current-model" | "first-available"> } {
	if (explicitSelection?.value) return { value: explicitSelection.value, source: explicitSelection.source ?? "flag" };
	if (envValue) return { value: envValue, source: "env" };
	if (sessionValue) return { value: sessionValue, source: "session" };
	if (configValue) return { value: configValue, source: "config" };
	return {};
}

function appendUnique(values: string[], value: string | undefined): void {
	if (!value || values.includes(value)) return;
	values.push(value);
}

export function expandRoleCandidates(profile: ModelProfileConfig, roleName: string, trace: string[]): string[] {
	const ordered: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (nextRoleName: string) => {
		if (visited.has(nextRoleName)) return;
		if (visiting.has(nextRoleName)) {
			pushTrace(trace, `cycle detected in fallback chain at role ${nextRoleName}`);
			return;
		}

		visiting.add(nextRoleName);
		visited.add(nextRoleName);
		ordered.push(nextRoleName);

		const role = profile.roles[nextRoleName];
		for (const fallbackRoleName of role?.fallback ?? []) {
			visit(fallbackRoleName);
		}

		visiting.delete(nextRoleName);
	};

	visit(roleName);
	return ordered;
}

export function getRoleTargets(roleConfig: ModelRoleConfig | undefined): ResolvedModelRef[] {
	if (!roleConfig) return [];
	if (roleConfig.targets && roleConfig.targets.length > 0) {
		return roleConfig.targets
			.filter((target): target is Required<Pick<ResolvedModelRef, "provider" | "model">> & ResolvedModelRef => !!target.provider && !!target.model)
			.map((target) => ({
				provider: target.provider,
				model: target.model,
				thinkingLevel: target.thinkingLevel,
			}));
	}
	if (roleConfig.provider && roleConfig.model) {
		return [{
			provider: roleConfig.provider,
			model: roleConfig.model,
			thinkingLevel: roleConfig.thinkingLevel,
		}];
	}
	return [];
}

async function resolveConfiguredCandidates(
	roleName: string,
	roleConfig: ModelRoleConfig | undefined,
	input: ResolveModelRoleInput,
	trace: string[],
): Promise<ResolvedRoleCandidate[]> {
	if (!roleConfig) {
		pushTrace(trace, `role ${roleName} missing`);
		return [];
	}

	const targets = getRoleTargets(roleConfig);
	if (targets.length === 0) {
		pushTrace(trace, `role ${roleName} incomplete; provider/model or targets required`);
		return [];
	}

	const candidates: ResolvedRoleCandidate[] = [];
	for (const [index, target] of targets.entries()) {
		const model = input.modelRegistry.find(target.provider, target.model);
		if (!model) {
			pushTrace(trace, `role ${roleName} target ${index + 1} ${target.provider}/${target.model} not found in registry`);
			continue;
		}

		const auth = await input.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			pushTrace(trace, `role ${roleName} target ${index + 1} ${modelLabel(model)} auth unavailable: ${auth.error}`);
			continue;
		}

		pushTrace(trace, `role ${roleName} target ${index + 1} resolved to ${modelLabel(model)}`);
		candidates.push({
			model,
			ref: target,
			matchedRole: roleName,
		});
	}

	return candidates;
}

async function resolveCurrentModel(
	currentModel: Model<any> | undefined,
	input: ResolveModelRoleInput,
	trace: string[],
): Promise<Model<any> | null> {
	if (!currentModel) return null;
	const auth = await input.modelRegistry.getApiKeyAndHeaders(currentModel);
	if (!auth.ok) {
		pushTrace(trace, `current model ${modelLabel(currentModel)} auth unavailable: ${auth.error}`);
		return null;
	}
	pushTrace(trace, `using current model ${modelLabel(currentModel)}`);
	return currentModel;
}

async function resolveFirstAvailableModel(input: ResolveModelRoleInput, trace: string[]): Promise<Model<any> | null> {
	const available = await Promise.resolve(input.modelRegistry.getAvailable());
	const model = available[0];
	if (!model) {
		pushTrace(trace, "no available models in registry");
		return null;
	}
	pushTrace(trace, `using first available model ${modelLabel(model)}`);
	return model;
}

export function readModelProfilesState(entries: ReadonlyArray<SessionEntryLike>): ModelProfilesState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom") continue;
		if (entry.customType !== MODEL_PROFILES_STATE_CUSTOM_TYPE) continue;
		return normalizeModelProfilesState(entry.data);
	}
	return {};
}

export async function resolveModelRole(input: ResolveModelRoleInput): Promise<ResolvedRoleResult | null> {
	const trace: string[] = [];
	const config: ModelProfilesConfig = input.config ?? { profiles: {} };
	const state = input.state ?? {};
	const env = input.env ?? process.env;

	const selectedProfile = getSelectionValue(input.profile, env.PI_MODEL_PROFILE, state.activeProfile, config.activeProfile);
	const profileName = selectedProfile.value;
	const profile = profileName ? config.profiles[profileName] : undefined;

	if (profileName && !profile) pushTrace(trace, `profile ${profileName} not found`);
	if (profileName && profile) pushTrace(trace, `profile ${profileName} selected via ${selectedProfile.source}`);

	const selectedRole = getSelectionValue(input.role, env.PI_MODEL_ROLE, state.activeRole, undefined);
	const defaultRole = profile?.defaultRole;
	const roleName = selectedRole.value ?? defaultRole;
	const roleSource = selectedRole.value ? selectedRole.source : defaultRole ? selectedProfile.source ?? "config" : undefined;

	if (selectedRole.value) pushTrace(trace, `role ${selectedRole.value} selected via ${selectedRole.source}`);
	else if (defaultRole) pushTrace(trace, `role defaulted to ${defaultRole}`);

	if (profile && roleName) {
		const candidateRoles = expandRoleCandidates(profile, roleName, trace);
		appendUnique(candidateRoles, defaultRole && defaultRole !== roleName ? defaultRole : undefined);
		const candidates: ResolvedRoleCandidate[] = [];
		for (const candidateRoleName of candidateRoles) {
			const resolvedCandidates = await resolveConfiguredCandidates(candidateRoleName, profile.roles[candidateRoleName], input, trace);
			candidates.push(...resolvedCandidates);
		}
		if (candidates.length > 0) {
			const primary = candidates[0]!;
			return {
				model: primary.model,
				ref: primary.ref,
				thinkingLevel: primary.ref.thinkingLevel,
				profile: profileName,
				role: roleName,
				matchedRole: primary.matchedRole,
				source: chooseSource(roleSource, selectedProfile.source),
				trace,
				candidates,
			};
		}
	}

	if (input.allowModelFallbacks === false) {
		return null;
	}

	const currentModel = await resolveCurrentModel(input.currentModel, input, trace);
	if (currentModel) {
		const candidate = {
			model: currentModel,
			ref: {
				provider: currentModel.provider,
				model: currentModel.id,
			},
		};
		return {
			model: currentModel,
			ref: candidate.ref,
			profile: profileName,
			role: roleName,
			source: "current-model",
			trace,
			candidates: [candidate],
		};
	}

	const firstAvailableModel = await resolveFirstAvailableModel(input, trace);
	if (firstAvailableModel) {
		const candidate = {
			model: firstAvailableModel,
			ref: {
				provider: firstAvailableModel.provider,
				model: firstAvailableModel.id,
			},
		};
		return {
			model: firstAvailableModel,
			ref: candidate.ref,
			profile: profileName,
			role: roleName,
			source: "first-available",
			trace,
			candidates: [candidate],
		};
	}

	return null;
}
