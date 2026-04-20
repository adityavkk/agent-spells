import {
	BlockType,
	EmbeddedContentType,
	PreferredView,
	QuestionType,
	type Block,
	type CollectionItem,
	type EmbeddedContent,
	type ListItem,
	type Question,
	type QuestionConstraints,
	type QuestionOption,
	type RenderDoc,
} from "./baml_client/types";
import type { RenderBranchRef, RenderRuntime } from "./core";

const PLACEHOLDER_OPTIONAL_TEXT = new Set(["n/a", "na", "none", "null", "undefined", "not applicable"]);
const MAX_NAV_LABEL_LENGTH = 18;
const MAX_TABS_ITEMS = 7;

export interface NormalizeRenderDocOptions {
	fallbackMarkdown?: string;
	defaultTitle?: string;
}

export interface NormalizeRenderRuntimeOptions {
	renderSessionId: string;
	sourceEntryId: string;
	revision?: number;
}

interface NormalizeContext {
	usedIds: Set<string>;
	counters: Record<string, number>;
}

type LooseRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is LooseRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (PLACEHOLDER_OPTIONAL_TEXT.has(trimmed.toLowerCase())) return undefined;
	return trimmed;
}

function normalizePositiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const normalized = Math.trunc(value);
	return normalized > 0 ? normalized : undefined;
}

function truncateLabel(value: string, maxLength = MAX_NAV_LABEL_LENGTH): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function sanitizeIdCandidate(value: string): string | undefined {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || undefined;
}

function nextGeneratedId(prefix: string, ctx: NormalizeContext): string {
	ctx.counters[prefix] = (ctx.counters[prefix] ?? 0) + 1;
	return `${prefix}-${ctx.counters[prefix]}`;
}

function makeId(prefix: string, candidate: unknown, ctx: NormalizeContext): string {
	const base = typeof candidate === "string"
		? sanitizeIdCandidate(candidate) ?? nextGeneratedId(prefix, ctx)
		: nextGeneratedId(prefix, ctx);
	if (!ctx.usedIds.has(base)) {
		ctx.usedIds.add(base);
		return base;
	}
	let suffix = 2;
	while (ctx.usedIds.has(`${base}-${suffix}`)) suffix++;
	const unique = `${base}-${suffix}`;
	ctx.usedIds.add(unique);
	return unique;
}

function emptyQuestionConstraints(): QuestionConstraints {
	return {};
}

function normalizePreferredView(value: unknown, itemCount: number): PreferredView | undefined {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
	let preferred: PreferredView | undefined;
	if (normalized === "auto") preferred = PreferredView.AUTO;
	if (normalized === "stack") preferred = PreferredView.STACK;
	if (normalized === "tabs") preferred = PreferredView.TABS;
	if (!preferred) return undefined;
	if (preferred === PreferredView.TABS && (itemCount < 2 || itemCount > MAX_TABS_ITEMS)) {
		return PreferredView.STACK;
	}
	return preferred;
}

function normalizeQuestionType(value: unknown): QuestionType | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["text", "freeform", "free_form", "free-form", "open", "open_ended"].includes(normalized)) return QuestionType.TEXT;
	if (["single_choice", "single-choice", "single choice", "singlechoice", "single"].includes(normalized)) return QuestionType.SINGLE_CHOICE;
	if (["multiple_choice", "multiple-choice", "multiple choice", "multiplechoice", "multiple", "multi", "multi_select", "multi-select"].includes(normalized)) return QuestionType.MULTIPLE_CHOICE;
	if (["ranking", "rank", "ordered", "order", "ranked_list", "ranked-list"].includes(normalized)) return QuestionType.RANKING;
	return undefined;
}

function normalizeQuestionConstraints(value: unknown, type: QuestionType): QuestionConstraints | undefined {
	if (!isPlainObject(value)) return undefined;
	const minSelections = normalizePositiveInteger(value.minSelections);
	const maxSelections = normalizePositiveInteger(value.maxSelections);
	const minSentences = normalizePositiveInteger(value.minSentences);
	const maxSentences = normalizePositiveInteger(value.maxSentences);
	const constraints = emptyQuestionConstraints();

	if (type === QuestionType.TEXT) {
		if (minSentences !== undefined) constraints.minSentences = minSentences;
		if (maxSentences !== undefined) constraints.maxSentences = maxSentences;
		if (
			constraints.minSentences !== undefined
			&& constraints.maxSentences !== undefined
			&& constraints.minSentences > constraints.maxSentences
		) {
			constraints.maxSentences = constraints.minSentences;
		}
	} else {
		if (minSelections !== undefined) constraints.minSelections = minSelections;
		if (maxSelections !== undefined) constraints.maxSelections = maxSelections;
		if (
			constraints.minSelections !== undefined
			&& constraints.maxSelections !== undefined
			&& constraints.minSelections > constraints.maxSelections
		) {
			constraints.maxSelections = constraints.minSelections;
		}
	}

	return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function normalizeQuestionOption(value: unknown, ctx: NormalizeContext): QuestionOption | null {
	if (typeof value === "string") {
		const label = normalizeOptionalText(value);
		if (!label) return null;
		return {
			id: makeId("option", label, ctx),
			label,
			value: label,
		};
	}
	if (!isPlainObject(value)) return null;
	const label = normalizeOptionalText(value.label);
	if (!label) return null;
	const option: QuestionOption = {
		id: makeId("option", value.id ?? label, ctx),
		label,
		value: normalizeOptionalText(value.value) ?? label,
	};
	const description = normalizeOptionalText(value.description);
	if (description) option.description = description;
	return option;
}

function normalizeQuestion(value: unknown, ctx: NormalizeContext): Question | null {
	if (!isPlainObject(value)) return null;
	const questionText = normalizeOptionalText(value.question);
	if (!questionText) return null;

	const options = Array.isArray(value.options)
		? value.options.map((option) => normalizeQuestionOption(option, ctx)).filter((option): option is QuestionOption => option !== null)
		: [];

	let type = normalizeQuestionType(value.type);
	if (!type) type = options.length > 0 ? QuestionType.SINGLE_CHOICE : QuestionType.TEXT;
	if (
		(type === QuestionType.SINGLE_CHOICE || type === QuestionType.MULTIPLE_CHOICE || type === QuestionType.RANKING)
		&& options.length === 0
	) {
		type = QuestionType.TEXT;
	}

	const question: Question = {
		id: makeId("question", value.id ?? questionText, ctx),
		type,
		question: questionText,
		options: type === QuestionType.TEXT ? [] : options,
		allowOther: false,
	};

	const context = normalizeOptionalText(value.context);
	if (context) question.context = context;
	const answerInstructions = normalizeOptionalText(value.answerInstructions);
	if (answerInstructions) question.answerInstructions = answerInstructions;
	const constraints = normalizeQuestionConstraints(value.constraints, type);
	if (constraints) question.constraints = constraints;

	if ((type === QuestionType.SINGLE_CHOICE || type === QuestionType.MULTIPLE_CHOICE) && value.allowOther === true) {
		question.allowOther = true;
		question.otherLabel = normalizeOptionalText(value.otherLabel) ?? "Other";
	}

	return question;
}

function normalizeListItem(value: unknown, ctx: NormalizeContext): ListItem | null {
	if (typeof value === "string") {
		const markdown = normalizeOptionalText(value);
		if (!markdown) return null;
		const title = markdown.split("\n")[0]?.trim() || undefined;
		const item: ListItem = {
			id: makeId("item", title ?? markdown, ctx),
			bodyMarkdown: markdown,
		};
		if (title) {
			item.title = title;
			item.navLabel = truncateLabel(title);
		}
		return item;
	}
	if (!isPlainObject(value)) return null;
	const title = normalizeOptionalText(value.title);
	const summary = normalizeOptionalText(value.summary);
	const navLabel = normalizeOptionalText(value.navLabel);
	const bodyMarkdown = normalizeOptionalText(value.bodyMarkdown) ?? normalizeOptionalText(value.markdown) ?? title ?? summary ?? navLabel;
	if (!bodyMarkdown) return null;
	const navLabelSource = navLabel ?? title ?? summary ?? bodyMarkdown.split("\n")[0]?.trim();
	const item: ListItem = {
		id: makeId("item", value.id ?? title ?? navLabelSource ?? bodyMarkdown, ctx),
		bodyMarkdown,
	};
	if (navLabelSource) item.navLabel = truncateLabel(navLabelSource);
	if (title) item.title = title;
	if (summary) item.summary = summary;
	return item;
}

function emptyEmbeddedContent(type: EmbeddedContentType): EmbeddedContent {
	return {
		type,
		items: [],
		questions: [],
	};
}

function normalizeEmbeddedContent(value: unknown, ctx: NormalizeContext): EmbeddedContent | null {
	if (typeof value === "string") {
		const markdown = normalizeOptionalText(value);
		if (!markdown) return null;
		return {
			...emptyEmbeddedContent(EmbeddedContentType.MARKDOWN),
			markdown,
		};
	}
	if (!isPlainObject(value)) return null;

	const inferredType = normalizeBlockType(value);
	if (inferredType === BlockType.MARKDOWN) {
		const markdown = normalizeOptionalText(value.markdown);
		if (!markdown) return null;
		return {
			...emptyEmbeddedContent(EmbeddedContentType.MARKDOWN),
			markdown,
		};
	}
	if (inferredType === BlockType.LIST) {
		const items = Array.isArray(value.items)
			? value.items.map((item) => normalizeListItem(item, ctx)).filter((item): item is ListItem => item !== null)
			: [];
		if (items.length === 0) return null;
		return {
			...emptyEmbeddedContent(EmbeddedContentType.LIST),
			ordered: value.ordered === true,
			items,
		};
	}
	if (inferredType === BlockType.QUESTIONNAIRE) {
		const questions = Array.isArray(value.questions)
			? value.questions.map((question) => normalizeQuestion(question, ctx)).filter((question): question is Question => question !== null)
			: [];
		if (questions.length === 0) return null;
		return {
			...emptyEmbeddedContent(EmbeddedContentType.QUESTIONNAIRE),
			questions,
		};
	}

	const markdown = normalizeOptionalText(value.markdown);
	if (!markdown) return null;
	return {
		...emptyEmbeddedContent(EmbeddedContentType.MARKDOWN),
		markdown,
	};
}

function normalizeCollectionItem(value: unknown, ctx: NormalizeContext): CollectionItem | null {
	if (!isPlainObject(value)) return null;
	const title = normalizeOptionalText(value.title);
	const summary = normalizeOptionalText(value.summary);
	const content = normalizeEmbeddedContent(
		value.content
			?? (normalizeOptionalText(value.markdown) ? { type: "markdown", markdown: value.markdown } : undefined)
			?? (normalizeOptionalText(value.bodyMarkdown) ? { type: "markdown", markdown: value.bodyMarkdown } : undefined)
			?? (Array.isArray(value.questions) ? { type: "questionnaire", questions: value.questions } : undefined)
			?? (Array.isArray(value.items) ? { type: "list", items: value.items, ordered: value.ordered } : undefined),
		ctx,
	);
	if (!content) return null;
	const navLabelSource = normalizeOptionalText(value.navLabel) ?? title ?? summary;
	const item: CollectionItem = {
		id: makeId("collection-item", value.id ?? title ?? navLabelSource ?? "item", ctx),
		content,
	};
	if (navLabelSource) item.navLabel = truncateLabel(navLabelSource);
	if (title) item.title = title;
	if (summary) item.summary = summary;
	return item;
}

function normalizeBlockType(raw: LooseRecord): BlockType | undefined {
	const explicit = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
	if (explicit === "markdown") return BlockType.MARKDOWN;
	if (explicit === "list") return BlockType.LIST;
	if (explicit === "questionnaire") return BlockType.QUESTIONNAIRE;
	if (explicit === "collection") return BlockType.COLLECTION;
	if (normalizeOptionalText(raw.markdown)) return BlockType.MARKDOWN;
	if (Array.isArray(raw.collectionItems)) return BlockType.COLLECTION;
	if (Array.isArray(raw.questions) && raw.questions.length > 0) return BlockType.QUESTIONNAIRE;
	if (Array.isArray(raw.items)) {
		const firstItem = raw.items[0];
		if (isPlainObject(firstItem) && "content" in firstItem) return BlockType.COLLECTION;
		return BlockType.LIST;
	}
	if (Array.isArray(raw.questions)) return BlockType.QUESTIONNAIRE;
	return undefined;
}

function emptyBlock(type: BlockType): Block {
	return {
		type,
		items: [],
		questions: [],
		collectionItems: [],
	};
}

function normalizeMarkdownBlock(raw: LooseRecord, ctx: NormalizeContext): Block | null {
	const markdown = normalizeOptionalText(raw.markdown);
	if (!markdown) return null;
	return {
		...emptyBlock(BlockType.MARKDOWN),
		id: makeId("block", raw.id ?? "markdown", ctx),
		markdown,
	};
}

function normalizeListBlock(raw: LooseRecord, ctx: NormalizeContext): Block | null {
	const items = Array.isArray(raw.items)
		? raw.items.map((item) => normalizeListItem(item, ctx)).filter((item): item is ListItem => item !== null)
		: [];
	if (items.length === 0) return null;
	const block: Block = {
		...emptyBlock(BlockType.LIST),
		id: makeId("block", raw.id ?? raw.title ?? "list", ctx),
		ordered: raw.ordered === true,
		items,
	};
	const title = normalizeOptionalText(raw.title);
	if (title) block.title = title;
	const preferredView = normalizePreferredView(raw.preferredView, items.length);
	if (preferredView) block.preferredView = preferredView;
	return block;
}

function normalizeQuestionnaireBlock(raw: LooseRecord, ctx: NormalizeContext): Block | null {
	const questions = Array.isArray(raw.questions)
		? raw.questions.map((question) => normalizeQuestion(question, ctx)).filter((question): question is Question => question !== null)
		: [];
	if (questions.length === 0) return null;
	const block: Block = {
		...emptyBlock(BlockType.QUESTIONNAIRE),
		id: makeId("block", raw.id ?? raw.title ?? "questionnaire", ctx),
		questions,
	};
	const title = normalizeOptionalText(raw.title);
	if (title) block.title = title;
	return block;
}

function normalizeCollectionBlock(raw: LooseRecord, ctx: NormalizeContext): Block | null {
	const rawItems = Array.isArray(raw.collectionItems)
		? raw.collectionItems
		: Array.isArray(raw.items)
			? raw.items
			: [];
	const collectionItems = rawItems
		.map((item) => normalizeCollectionItem(item, ctx))
		.filter((item): item is CollectionItem => item !== null);
	if (collectionItems.length === 0) return null;
	const block: Block = {
		...emptyBlock(BlockType.COLLECTION),
		id: makeId("block", raw.id ?? raw.title ?? "collection", ctx),
		collectionItems,
	};
	const title = normalizeOptionalText(raw.title);
	if (title) block.title = title;
	const preferredView = normalizePreferredView(raw.preferredView, collectionItems.length);
	if (preferredView) block.preferredView = preferredView;
	return block;
}

function normalizeBlock(value: unknown, ctx: NormalizeContext): Block | null {
	if (!isPlainObject(value)) return null;
	const type = normalizeBlockType(value);
	if (!type) return null;
	if (type === BlockType.MARKDOWN) return normalizeMarkdownBlock(value, ctx);
	if (type === BlockType.LIST) return normalizeListBlock(value, ctx);
	if (type === BlockType.QUESTIONNAIRE) return normalizeQuestionnaireBlock(value, ctx);
	return normalizeCollectionBlock(value, ctx);
}

function createFallbackMarkdownBlock(markdown: string, ctx: NormalizeContext): Block {
	return {
		...emptyBlock(BlockType.MARKDOWN),
		id: makeId("block", "fallback-markdown", ctx),
		markdown,
	};
}

export function normalizeRenderDoc(input: unknown, options: NormalizeRenderDocOptions = {}): RenderDoc {
	const ctx: NormalizeContext = {
		usedIds: new Set(),
		counters: {},
	};
	const raw = isPlainObject(input) ? input : {};
	const title = normalizeOptionalText(raw.title) ?? normalizeOptionalText(options.defaultTitle);
	const introMarkdown = normalizeOptionalText(raw.introMarkdown);

	let blocks = Array.isArray(raw.blocks)
		? raw.blocks.map((block) => normalizeBlock(block, ctx)).filter((block): block is Block => block !== null)
		: [];
	if (blocks.length === 0) {
		const inferredBlock = normalizeBlock(raw, ctx);
		if (inferredBlock) blocks = [inferredBlock];
	}
	if (blocks.length === 0) {
		const fallbackMarkdown = normalizeOptionalText(options.fallbackMarkdown)
			?? normalizeOptionalText(raw.markdown)
			?? introMarkdown
			?? "No content available.";
		blocks = [createFallbackMarkdownBlock(fallbackMarkdown, ctx)];
	}

	const normalized: RenderDoc = { blocks };
	if (title) normalized.title = title;
	if (introMarkdown) normalized.introMarkdown = introMarkdown;
	return normalized;
}

export function normalizeRenderBranchRef(input: unknown): RenderBranchRef {
	if (!isPlainObject(input)) {
		return { mode: "none" };
	}
	const mode = input.mode === "tree-revision" ? "tree-revision" : "none";
	const branch: RenderBranchRef = { mode };
	const sessionFile = normalizeOptionalText(input.sessionFile);
	const leafEntryId = normalizeOptionalText(input.leafEntryId);
	if (sessionFile) branch.sessionFile = sessionFile;
	if (leafEntryId) branch.leafEntryId = leafEntryId;
	return branch;
}

export function createInitialRenderRuntime(options: NormalizeRenderRuntimeOptions): RenderRuntime {
	return {
		renderSessionId: options.renderSessionId,
		sourceEntryId: options.sourceEntryId,
		revision: options.revision && options.revision > 0 ? Math.trunc(options.revision) : 1,
		selections: {},
		answers: {},
		edits: {},
		branch: { mode: "none" },
	};
}

export function normalizeRenderRuntime(input: unknown, options: NormalizeRenderRuntimeOptions): RenderRuntime {
	const base = createInitialRenderRuntime(options);
	if (!isPlainObject(input)) return base;
	return {
		renderSessionId: normalizeOptionalText(input.renderSessionId) ?? base.renderSessionId,
		sourceEntryId: normalizeOptionalText(input.sourceEntryId) ?? base.sourceEntryId,
		revision: normalizePositiveInteger(input.revision) ?? base.revision,
		selections: isPlainObject(input.selections) ? input.selections : {},
		answers: isPlainObject(input.answers) ? input.answers : {},
		edits: isPlainObject(input.edits) ? input.edits : {},
		branch: normalizeRenderBranchRef(input.branch),
	};
}
