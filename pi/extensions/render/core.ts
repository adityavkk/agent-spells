import type { RenderDoc } from "./baml_client/types";

export type RenderBranchMode = "none" | "tree-revision";
export type RenderRevisionKind = "initial" | "answer" | "select" | "edit" | "regenerate" | "export" | "branch";

export interface RenderSourceRef {
	entryId: string;
	role: "assistant";
	sessionFile?: string;
}

export interface RenderBranchRef {
	mode: RenderBranchMode;
	sessionFile?: string;
	leafEntryId?: string;
}

export interface RenderRuntime {
	renderSessionId: string;
	sourceEntryId: string;
	revision: number;
	selections: Record<string, unknown>;
	answers: Record<string, unknown>;
	edits: Record<string, unknown>;
	branch: RenderBranchRef;
}

export interface RenderRevision {
	id: string;
	sessionId: string;
	number: number;
	kind: RenderRevisionKind;
	createdAt: number;
	parentRevisionId?: string;
	doc: RenderDoc;
	runtime: RenderRuntime;
	metadata?: RenderRevisionMetadata;
}

export interface RenderRevisionMetadata {
	reason?: string;
	surface?: string;
	instructions?: string;
	authoredBy?: "extractor" | "user" | "system";
}

export interface RenderSession {
	id: string;
	source: RenderSourceRef;
	createdAt: number;
	updatedAt: number;
	currentRevisionId: string;
	revisions: RenderRevision[];
}

export type RenderAction =
	| RenderAnswerAction
	| RenderSelectAction
	| RenderEditAction
	| RenderRegenerateAction
	| RenderExportAction
	| RenderBranchAction;

export interface RenderAnswerAction {
	type: "answer";
	questionId: string;
	value: unknown;
}

export interface RenderSelectAction {
	type: "select";
	targetId: string;
	value: unknown;
}

export interface RenderEditAction {
	type: "edit";
	targetId: string;
	instructions?: string;
	replacement?: unknown;
}

export interface RenderRegenerateAction {
	type: "regenerate";
	instructions?: string;
}

export interface RenderExportAction {
	type: "export";
	surface: string;
	options?: unknown;
}

export interface RenderBranchAction {
	type: "branch";
	fromRevisionId: string;
	mode: Exclude<RenderBranchMode, "none">;
}

export interface RenderSurface<Options = unknown, Output = unknown> {
	name: string;
	render(doc: RenderDoc, runtime: RenderRuntime, options?: Options): Promise<Output> | Output;
}

export interface RenderSurfaceRequest<Options = unknown> {
	surface: string;
	options?: Options;
}
