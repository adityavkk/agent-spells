import type { Model } from "@mariozechner/pi-ai";
import type { ModelProfilesState, ModelProfilesThinkingLevel, ResolvedRoleResult } from "./types";

function modelLabel(model: Model<any> | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

export interface ModelProfilesStatusInput {
	state: ModelProfilesState;
	resolved?: ResolvedRoleResult | null;
	currentModel?: Model<any>;
	unresolved?: boolean;
}

export function isRawOverride(resolved: ResolvedRoleResult | null | undefined, currentModel: Model<any> | undefined): boolean {
	if (!resolved || !currentModel) return false;
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
	if (isRawOverride(input.resolved, input.currentModel)) return `${base} raw-override`;
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
	return `${status} model:${currentLabel} resolved:${resolvedLabel}`;
}
