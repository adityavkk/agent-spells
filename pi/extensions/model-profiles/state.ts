import type { Model } from "@mariozechner/pi-ai";
import type { ModelProfilesState, ResolvedRoleResult } from "./types";

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
	const parts: string[] = [];
	if (input.state.activeProfile) parts.push(`profile:${input.state.activeProfile}`);
	if (input.state.activeRole) parts.push(`role:${input.state.activeRole}`);
	if (parts.length === 0) return undefined;
	if (input.unresolved) parts.push("unresolved");
	else if (isRawOverride(input.resolved, input.currentModel)) parts.push("raw-override");
	return parts.join(" ");
}

export function formatResolvedRoleSummary(resolved: ResolvedRoleResult): string {
	const parts = [`${resolved.ref.provider}/${resolved.ref.model}`];
	if (resolved.thinkingLevel) parts.push(`thinking:${resolved.thinkingLevel}`);
	if (resolved.matchedRole && resolved.role && resolved.matchedRole !== resolved.role) {
		parts.push(`matched:${resolved.matchedRole}`);
	}
	parts.push(`source:${resolved.source}`);
	return parts.join(" ");
}

export function formatModelProfilesStateSummary(input: ModelProfilesStatusInput): string {
	const status = formatModelProfilesStatus(input) ?? "profile:none role:none";
	const resolvedLabel = input.resolved ? formatResolvedRoleSummary(input.resolved) : "unresolved";
	const currentLabel = modelLabel(input.currentModel) ?? "none";
	return `${status} model:${currentLabel} resolved:${resolvedLabel}`;
}
