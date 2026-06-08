import type { ExtensionAPI, ExtensionContext } from "./pi-compat";
import { textResult, type TextResultDetails, type ToolTextResult } from "./results";

export const CODEX_PLAN_CUSTOM_TYPE = "provider-tool-profiles.codex.plan.v1";

export type CodexPlanStatus = "pending" | "in_progress" | "completed";

export interface CodexPlanItem {
	step: string;
	status: CodexPlanStatus;
}

export interface CodexPlanEntryData {
	version: 1;
	plan: CodexPlanItem[];
	explanation?: string;
	updatedAt: string;
}

export interface CodexPlanDetails extends TextResultDetails {
	plan: CodexPlanItem[];
	persisted: boolean;
	customType: typeof CODEX_PLAN_CUSTOM_TYPE;
}

function isPlanStatus(value: unknown): value is CodexPlanStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

function normalizePlan(rawPlan: unknown): CodexPlanItem[] | undefined {
	if (!Array.isArray(rawPlan)) return undefined;
	const plan: CodexPlanItem[] = [];
	for (const rawItem of rawPlan) {
		if (!rawItem || typeof rawItem !== "object") return undefined;
		const item = rawItem as Record<string, unknown>;
		if (typeof item.step !== "string" || !isPlanStatus(item.status)) return undefined;
		plan.push({ step: item.step, status: item.status });
	}
	return plan;
}

function normalizeEntryData(data: unknown): CodexPlanEntryData | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	const plan = normalizePlan(record.plan);
	if (!plan) return undefined;
	if (record.explanation !== undefined && typeof record.explanation !== "string") return undefined;
	return {
		version: 1,
		plan,
		explanation: record.explanation,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
	};
}

export function planSummary(plan: readonly CodexPlanItem[]): string {
	return plan.map((item) => `- [${item.status}] ${item.step}`).join("\n");
}

export function latestPlanFromEntries(entries: readonly unknown[]): CodexPlanEntryData | undefined {
	let latest: CodexPlanEntryData | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "custom" || record.customType !== CODEX_PLAN_CUSTOM_TYPE) continue;
		const data = normalizeEntryData(record.data);
		if (data) latest = data;
	}
	return latest;
}

export class CodexPlanState {
	private currentPlan: CodexPlanItem[] = [];

	constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

	loadFromSession(ctx: Pick<ExtensionContext, "sessionManager">): void {
		const latest = latestPlanFromEntries(ctx.sessionManager.getBranch());
		this.currentPlan = latest?.plan ?? [];
	}

	current(): CodexPlanItem[] {
		return this.currentPlan.map((item) => ({ ...item }));
	}

	update(plan: CodexPlanItem[], explanation?: string): ToolTextResult<CodexPlanDetails> {
		this.currentPlan = plan.map((item) => ({ ...item }));
		const data: CodexPlanEntryData = {
			version: 1,
			plan: this.current(),
			explanation,
			updatedAt: new Date().toISOString(),
		};
		this.pi.appendEntry(CODEX_PLAN_CUSTOM_TYPE, data);
		const summary = [explanation, planSummary(this.currentPlan)].filter(Boolean).join("\n\n");
		return textResult(summary || "Plan updated", {
			plan: this.current(),
			persisted: true,
			customType: CODEX_PLAN_CUSTOM_TYPE,
		});
	}
}

export function createCodexPlanState(pi: Pick<ExtensionAPI, "appendEntry">): CodexPlanState {
	return new CodexPlanState(pi);
}
