/**
 * In-memory analysis store keyed by `toolCallId`, plus helpers to build audit
 * payloads and reconstruct state from the current session branch.
 *
 * Sessions are append-only: a record is never edited in place. During a run we
 * append one hidden `custom` audit entry per phase; at idle we flush one
 * consolidated card. On reload we rebuild by scanning the branch, preferring a
 * flushed card's `details`, else the latest audit phase per tool call.
 */
import { normalizeRecord } from "./normalize";
import {
	TOOL_LENS_ANALYSIS_SCHEMA,
	TOOL_LENS_AUDIT_CUSTOM_TYPE,
	TOOL_LENS_CARD_CUSTOM_TYPE,
	type ToolLensCardDetails,
	type ToolLensIntent,
	type ToolLensOutcome,
	type ToolLensPhase,
	type ToolLensRecordV1,
	type ToolLensStatus,
} from "./types";

/** Minimal structural view of a session branch entry we care about. */
export interface BranchEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		customType?: string;
		details?: unknown;
	};
}

export interface SeedRecordInput {
	toolCallId: string;
	turnIndex: number;
	sourceOrder: number;
	toolName: string;
	canonicalToolName: string;
	startedAt: number;
}

export class ToolLensStore {
	private readonly records = new Map<string, ToolLensRecordV1>();

	/** Create (or return existing) record for a tool call at start. */
	seed(input: SeedRecordInput): ToolLensRecordV1 {
		const existing = this.records.get(input.toolCallId);
		if (existing) return existing;
		const record: ToolLensRecordV1 = {
			schema: TOOL_LENS_ANALYSIS_SCHEMA,
			toolCallId: input.toolCallId,
			turnIndex: input.turnIndex,
			sourceOrder: input.sourceOrder,
			toolName: input.toolName,
			canonicalToolName: input.canonicalToolName,
			startedAt: input.startedAt,
			status: "observed",
		};
		this.records.set(input.toolCallId, record);
		return record;
	}

	get(toolCallId: string): ToolLensRecordV1 | undefined {
		return this.records.get(toolCallId);
	}

	has(toolCallId: string): boolean {
		return this.records.has(toolCallId);
	}

	/** Shallow-merge a partial update into a record, preserving identity. */
	update(toolCallId: string, patch: Partial<ToolLensRecordV1>): ToolLensRecordV1 | undefined {
		const existing = this.records.get(toolCallId);
		if (!existing) return undefined;
		const next: ToolLensRecordV1 = { ...existing, ...patch, toolCallId: existing.toolCallId, schema: TOOL_LENS_ANALYSIS_SCHEMA };
		this.records.set(toolCallId, next);
		return next;
	}

	setStatus(toolCallId: string, status: ToolLensStatus): void {
		this.update(toolCallId, { status });
	}

	setIntent(toolCallId: string, intent: ToolLensIntent): void {
		this.update(toolCallId, { intent });
	}

	setOutcome(toolCallId: string, outcome: ToolLensOutcome): void {
		this.update(toolCallId, { outcome });
	}

	appendError(toolCallId: string, message: string): void {
		const existing = this.records.get(toolCallId);
		if (!existing) return;
		this.update(toolCallId, { errors: [...(existing.errors ?? []), message] });
	}

	/** Restore a record wholesale (used by reconstruction). */
	put(record: ToolLensRecordV1): void {
		this.records.set(record.toolCallId, record);
	}

	/** All records in stable source order, then start time, then id. */
	allSourceOrdered(): ToolLensRecordV1[] {
		return [...this.records.values()].sort(compareSourceOrder);
	}

	clear(): void {
		this.records.clear();
	}

	get size(): number {
		return this.records.size;
	}
}

export function compareSourceOrder(a: ToolLensRecordV1, b: ToolLensRecordV1): number {
	if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
	if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
	if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
	return a.toolCallId.localeCompare(b.toolCallId);
}

/** Build the per-phase audit payload (record with `phase` set). */
export function buildAuditPayload(record: ToolLensRecordV1, phase: ToolLensPhase): ToolLensRecordV1 {
	return { ...record, phase };
}

/** Build the consolidated card details (record with `phase` omitted). */
export function buildCardDetails(record: ToolLensRecordV1): ToolLensCardDetails {
	const { phase: _phase, ...rest } = record;
	return { record: { ...rest } };
}

function isCardEntry(entry: BranchEntryLike): boolean {
	return entry.type === "message" && entry.message?.role === "custom" && entry.message?.customType === TOOL_LENS_CARD_CUSTOM_TYPE;
}

function isAuditEntry(entry: BranchEntryLike): boolean {
	return entry.type === "custom" && entry.customType === TOOL_LENS_AUDIT_CUSTOM_TYPE;
}

/**
 * Reconstruct records from a session branch. Walks in order so the latest entry
 * per `toolCallId` wins; card `details` take precedence over audit phases
 * because cards are the final consolidated artifact.
 */
export function reconstructFromBranch(branch: BranchEntryLike[]): ToolLensRecordV1[] {
	const byId = new Map<string, { record: ToolLensRecordV1; fromCard: boolean }>();
	for (const entry of branch) {
		let candidate: ToolLensRecordV1 | null = null;
		let fromCard = false;
		if (isCardEntry(entry)) {
			const details = entry.message?.details as ToolLensCardDetails | undefined;
			candidate = normalizeRecord(details?.record);
			fromCard = true;
		} else if (isAuditEntry(entry)) {
			candidate = normalizeRecord(entry.data);
		}
		if (!candidate) continue;
		const existing = byId.get(candidate.toolCallId);
		// A card always supersedes an audit phase; later cards supersede earlier.
		if (existing && existing.fromCard && !fromCard) continue;
		byId.set(candidate.toolCallId, { record: candidate, fromCard });
	}
	return [...byId.values()].map((entry) => entry.record).sort(compareSourceOrder);
}
