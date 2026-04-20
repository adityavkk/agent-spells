import { randomUUID } from "node:crypto";
import type { RenderDoc } from "./baml_client/types";
import type { RenderRuntime, RenderRevision, RenderSession } from "./core";
import { createInitialRenderRuntime } from "./normalize";

export const RENDER_MESSAGE_CUSTOM_TYPE = "render-session";

export interface RenderSessionMessageDetails {
	session: RenderSession;
}

interface BranchMessageLike {
	role?: string;
	customType?: string;
	details?: unknown;
}

interface BranchEntryLike {
	type?: string;
	message?: BranchMessageLike;
}

export interface CreateRenderSessionOptions {
	doc: RenderDoc;
	sourceEntryId: string;
	sourceSessionFile?: string;
	reason?: string;
	surface?: string;
}

function makeRenderSessionId(): string {
	return `render-${randomUUID()}`;
}

function makeRenderRevisionId(sessionId: string, revision: number): string {
	return `${sessionId}:r${revision}`;
}

export function getCurrentRenderRevision(session: RenderSession): RenderRevision {
	return session.revisions.find((revision) => revision.id === session.currentRevisionId)
		?? session.revisions[session.revisions.length - 1]!;
}

export function createRenderSession(options: CreateRenderSessionOptions): RenderSession {
	const sessionId = makeRenderSessionId();
	const now = Date.now();
	const runtime = createInitialRenderRuntime({
		renderSessionId: sessionId,
		sourceEntryId: options.sourceEntryId,
	});
	if (options.sourceSessionFile) {
		runtime.branch = {
			mode: "tree-revision",
			sessionFile: options.sourceSessionFile,
			leafEntryId: options.sourceEntryId,
		};
	}
	const revision: RenderRevision = {
		id: makeRenderRevisionId(sessionId, 1),
		sessionId,
		number: 1,
		kind: "initial",
		createdAt: now,
		doc: options.doc,
		runtime,
		metadata: {
			reason: options.reason,
			surface: options.surface,
			authoredBy: "extractor",
		},
	};
	return {
		id: sessionId,
		source: {
			entryId: options.sourceEntryId,
			role: "assistant",
			sessionFile: options.sourceSessionFile,
		},
		createdAt: now,
		updatedAt: now,
		currentRevisionId: revision.id,
		revisions: [revision],
	};
}

export function withCurrentRenderRuntime(session: RenderSession, runtime: RenderRuntime): RenderSession {
	const current = getCurrentRenderRevision(session);
	const nextRevision: RenderRevision = {
		...current,
		runtime,
	};
	return {
		...session,
		updatedAt: Date.now(),
		revisions: session.revisions.map((revision) => revision.id === current.id ? nextRevision : revision),
	};
}

export function getRenderSessionTitle(session: RenderSession): string {
	const doc = getCurrentRenderRevision(session).doc;
	return doc.title?.trim() || "Untitled render";
}

export function getRenderSessionSummary(session: RenderSession): string {
	const revision = getCurrentRenderRevision(session);
	const title = getRenderSessionTitle(session);
	const blockCount = revision.doc.blocks.length;
	return `${title} (${blockCount} block${blockCount === 1 ? "" : "s"})`;
}

export function readLatestRenderSession(branch: BranchEntryLike[]): RenderSession | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "custom" || message.customType !== RENDER_MESSAGE_CUSTOM_TYPE) continue;
		const details = message.details as RenderSessionMessageDetails | undefined;
		if (details?.session) return details.session;
	}
	return null;
}
