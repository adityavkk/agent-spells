import type { Model } from "@mariozechner/pi-ai";
import { buildSyntheticProfileModelId, parseSyntheticProfileModelId } from "./provider";
import { expandRoleCandidates, getRoleTargets } from "./resolve";
import {
	MODEL_PROFILES_PROVIDER,
	MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE,
	type ModelProfilesConfig,
	type ModelProfilesRuntimeDiagnostics,
	type ModelProfilesRuntimeSelectionState,
	type ModelProfilesRuntimeState,
	type ModelProfilesState,
	type ModelProfilesThinkingLevel,
	type ModelProfileConfig,
	type ResolvedRoleResult,
	type SessionEntryLike,
} from "./types";

function modelLabel(model: Model<any> | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

export interface ModelProfilesStatusInput {
	state: ModelProfilesState;
	config?: ModelProfilesConfig;
	resolved?: ResolvedRoleResult | null;
	currentModel?: Model<any>;
	unresolved?: boolean;
	runtimeDiagnostics?: ModelProfilesRuntimeDiagnostics | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeRuntimeAttempt(value: unknown) {
	if (!isRecord(value)) return undefined;
	const provider = normalizeString(value.provider);
	const model = normalizeString(value.model);
	const status = normalizeString(value.status) as ModelProfilesRuntimeSelectionState["lastAttempts"] extends Array<infer T> ? T["status"] : never;
	if (!provider || !model || !status) return undefined;
	return {
		provider,
		model,
		status,
		message: normalizeString(value.message),
	};
}

function normalizeRuntimeSelectionState(value: unknown): ModelProfilesRuntimeSelectionState | undefined {
	if (!isRecord(value)) return undefined;
	const cursor = typeof value.cursor === "number" && Number.isInteger(value.cursor) && value.cursor >= 0 ? value.cursor : undefined;
	const lastWinner = isRecord(value.lastWinner)
		? {
			provider: normalizeString(value.lastWinner.provider) ?? "",
			model: normalizeString(value.lastWinner.model) ?? "",
			thinkingLevel: normalizeString(value.lastWinner.thinkingLevel) as ResolvedRoleResult["thinkingLevel"],
		}
		: undefined;
	const lastAttempts = Array.isArray(value.lastAttempts)
		? value.lastAttempts.map(normalizeRuntimeAttempt).filter((attempt): attempt is NonNullable<ReturnType<typeof normalizeRuntimeAttempt>> => !!attempt)
		: undefined;
	const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : undefined;
	return {
		cursor,
		lastWinner: lastWinner?.provider && lastWinner.model ? lastWinner : undefined,
		lastAttempts: lastAttempts && lastAttempts.length > 0 ? lastAttempts : undefined,
		updatedAt,
	};
}

export function getModelProfilesSelectionKey(profile: string | undefined, role: string | undefined): string | undefined {
	if (!profile || !role) return undefined;
	return `${profile}:${role}`;
}

export function normalizeModelProfilesRuntimeState(input: unknown): ModelProfilesRuntimeState {
	if (!isRecord(input) || !isRecord(input.selections)) return { selections: {} };
	const selections: ModelProfilesRuntimeState["selections"] = {};
	for (const [key, value] of Object.entries(input.selections)) {
		const normalizedKey = normalizeString(key);
		const normalizedValue = normalizeRuntimeSelectionState(value);
		if (!normalizedKey || !normalizedValue) continue;
		selections[normalizedKey] = normalizedValue;
	}
	return { selections };
}

export function readModelProfilesRuntimeState(entries: ReadonlyArray<SessionEntryLike>): ModelProfilesRuntimeState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom") continue;
		if (entry.customType !== MODEL_PROFILES_RUNTIME_STATE_CUSTOM_TYPE) continue;
		return normalizeModelProfilesRuntimeState(entry.data);
	}
	return { selections: {} };
}

function buildRolePolicy(profile: ModelProfileConfig | undefined, roleName: string | undefined) {
	if (!profile || !roleName || !profile.roles[roleName]) return [];
	const trace: string[] = [];
	const orderedRoles = expandRoleCandidates(profile, roleName, trace);
	return orderedRoles.flatMap((name) => getRoleTargets(profile.roles[name])).map((target) => ({
		provider: target.provider,
		model: target.model,
		thinkingLevel: target.thinkingLevel,
	}));
}

function sameRolePolicy(config: ModelProfilesConfig | undefined, profileName: string | undefined, leftRole: string | undefined, rightRole: string | undefined): boolean {
	if (!config || !profileName || !leftRole || !rightRole) return false;
	const profile = config.profiles[profileName];
	if (!profile) return false;
	const left = buildRolePolicy(profile, leftRole);
	const right = buildRolePolicy(profile, rightRole);
	if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
	return left.every((target, index) => {
		const other = right[index];
		return target.provider === other?.provider && target.model === other?.model && target.thinkingLevel === other?.thinkingLevel;
	});
}

export function isRawOverride(input: {
	config?: ModelProfilesConfig;
	resolved: ResolvedRoleResult | null | undefined;
	currentModel: Model<any> | undefined;
}): boolean {
	const { config, resolved, currentModel } = input;
	if (!resolved || !currentModel) return false;
	if (
		resolved.profile
		&& resolved.role
		&& currentModel.provider === MODEL_PROFILES_PROVIDER
	) {
		if (currentModel.id === buildSyntheticProfileModelId(resolved.profile, resolved.role)) {
			return false;
		}
		const currentSelection = parseSyntheticProfileModelId(currentModel.id);
		if (
			currentSelection
			&& currentSelection.profile === resolved.profile
			&& sameRolePolicy(config, resolved.profile, resolved.role, currentSelection.role)
		) {
			return false;
		}
	}
	return resolved.ref.provider !== currentModel.provider || resolved.ref.model !== currentModel.id;
}

export function formatModelProfilesStatus(input: ModelProfilesStatusInput): string | undefined {
	const base = input.state.activeProfile && input.state.activeRole
		? `${input.state.activeProfile}:${input.state.activeRole}`
		: input.state.activeProfile
			? input.state.activeProfile
			: input.state.activeRole
				? input.state.activeRole
				: undefined;
	if (!base) return undefined;
	if (input.unresolved) return `${base} unresolved`;
	if (isRawOverride({ config: input.config, resolved: input.resolved, currentModel: input.currentModel })) return `${base} raw-override`;
	return base;
}

export function getAppliedThinkingLevel(resolved: ResolvedRoleResult): ModelProfilesThinkingLevel {
	return resolved.thinkingLevel ?? "off";
}

export function formatResolvedRoleSummary(resolved: ResolvedRoleResult): string {
	const parts = [`${resolved.ref.provider}/${resolved.ref.model}`];
	parts.push(`thinking:${getAppliedThinkingLevel(resolved)}`);
	if (resolved.matchedRole && resolved.role && resolved.matchedRole !== resolved.role) {
		parts.push(`matched:${resolved.matchedRole}`);
	}
	parts.push(`source:${resolved.source}`);
	return parts.join(" ");
}

export function formatModelProfilesStateSummary(input: ModelProfilesStatusInput): string {
	const status = formatModelProfilesStatus(input) ?? "none";
	const resolvedLabel = input.resolved ? formatResolvedRoleSummary(input.resolved) : "unresolved";
	const currentLabel = modelLabel(input.currentModel) ?? "none";
	const lines = [`${status} model:${currentLabel} resolved:${resolvedLabel}`];
	if (input.runtimeDiagnostics) {
		const winner = input.runtimeDiagnostics.winner
			? `${input.runtimeDiagnostics.winner.provider}/${input.runtimeDiagnostics.winner.model}`
			: "none";
		const candidateCount = input.resolved?.candidates.length ?? 0;
		const cursorLabel = candidateCount > 0
			? `${input.runtimeDiagnostics.nextCursor + 1}/${candidateCount}`
			: `${input.runtimeDiagnostics.nextCursor + 1}`;
		lines.push(`cursor:${cursorLabel} winner:${winner}`);
		if (input.runtimeDiagnostics.attempts.length > 0) {
			lines.push("attempts:");
			for (const attempt of input.runtimeDiagnostics.attempts) {
				const message = attempt.message ? ` ${attempt.message}` : "";
				lines.push(`- ${attempt.provider}/${attempt.model} ${attempt.status}${message}`);
			}
		}
	}
	return lines.join("\n");
}
