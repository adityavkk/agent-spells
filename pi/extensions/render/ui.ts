import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@mariozechner/pi-tui";
import { BlockType, EmbeddedContentType, QuestionType, type Block, type CollectionItem, type EmbeddedContent, type ListItem, type Question, type RenderDoc } from "./baml_client/types";
import type { RenderRuntime, RenderSession } from "./core";
import { getCurrentRenderRevision, getRenderSessionTitle } from "./session";

export interface RenderQuestionnaireSelection {
	key: string;
	title?: string;
	questions: Question[];
}

interface StoredQuestionnaireAnswer {
	title?: string;
	transcript?: string;
	structuredAnswers?: Array<{ answered?: boolean }>;
	submittedAt?: number;
}

export type RenderViewerResult =
	| { type: "close"; runtime: RenderRuntime }
	| { type: "answer"; runtime: RenderRuntime; questionnaire: RenderQuestionnaireSelection };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function defaultBlockLabel(block: Block): string {
	if (block.type === BlockType.MARKDOWN) return "Notes";
	if (block.type === BlockType.LIST) return "List";
	if (block.type === BlockType.QUESTIONNAIRE) return "Questions";
	return "Views";
}

function blockLabel(block: Block): string {
	return block.title?.trim() || defaultBlockLabel(block);
}

function questionTypeLabel(type: QuestionType): string {
	switch (type) {
		case QuestionType.SINGLE_CHOICE:
			return "pick one";
		case QuestionType.MULTIPLE_CHOICE:
			return "pick many";
		case QuestionType.RANKING:
			return "rank";
		default:
			return "freeform";
	}
}

function blockKindSummary(block: Block): string {
	if (block.type === BlockType.MARKDOWN) return "notes";
	if (block.type === BlockType.LIST) return `${block.items.length} item${block.items.length === 1 ? "" : "s"}`;
	if (block.type === BlockType.QUESTIONNAIRE) return `${block.questions.length} question${block.questions.length === 1 ? "" : "s"}`;
	return `${block.collectionItems.length} view${block.collectionItems.length === 1 ? "" : "s"}`;
}

function summarizeDoc(doc: RenderDoc): string {
	if (doc.blocks.length <= 3) {
		return doc.blocks.map((block) => blockLabel(block)).join(" • ");
	}
	return `${doc.blocks.length} sections`;
}

function getStoredAnswers(runtime: RenderRuntime): Record<string, StoredQuestionnaireAnswer> {
	const answers = runtime.answers;
	if (!isRecord(answers)) return {};
	const result: Record<string, StoredQuestionnaireAnswer> = {};
	for (const [key, value] of Object.entries(answers)) {
		if (!isRecord(value)) continue;
		result[key] = {
			title: typeof value.title === "string" ? value.title : undefined,
			transcript: typeof value.transcript === "string" ? value.transcript : undefined,
			structuredAnswers: Array.isArray(value.structuredAnswers) ? value.structuredAnswers : undefined,
			submittedAt: typeof value.submittedAt === "number" ? value.submittedAt : undefined,
		};
	}
	return result;
}

function getStoredQuestionnaireAnswer(runtime: RenderRuntime, key: string | undefined): StoredQuestionnaireAnswer | undefined {
	if (!key) return undefined;
	return getStoredAnswers(runtime)[key];
}

function countStoredQuestionnaireAnswers(runtime: RenderRuntime): number {
	return Object.keys(getStoredAnswers(runtime)).length;
}

function answeredCountLabel(count: number): string | undefined {
	if (count <= 0) return undefined;
	return `${count} answered`;
}

function questionConstraintSummary(question: Question): string | undefined {
	const constraints = question.constraints;
	if (!constraints) return undefined;
	const parts: string[] = [];
	if (constraints.minSelections && constraints.maxSelections) {
		parts.push(constraints.minSelections === constraints.maxSelections
			? `exactly ${constraints.minSelections}`
			: `${constraints.minSelections}-${constraints.maxSelections}`);
	} else if (constraints.minSelections) {
		parts.push(`min ${constraints.minSelections}`);
	} else if (constraints.maxSelections) {
		parts.push(`max ${constraints.maxSelections}`);
	}
	if (constraints.minSentences && constraints.maxSentences) {
		parts.push(constraints.minSentences === constraints.maxSentences
			? `${constraints.minSentences} sentence${constraints.minSentences === 1 ? "" : "s"}`
			: `${constraints.minSentences}-${constraints.maxSentences} sentences`);
	} else if (constraints.minSentences) {
		parts.push(`min ${constraints.minSentences} sentence${constraints.minSentences === 1 ? "" : "s"}`);
	} else if (constraints.maxSentences) {
		parts.push(`max ${constraints.maxSentences} sentence${constraints.maxSentences === 1 ? "" : "s"}`);
	}
	return parts.length > 0 ? parts.join(" • ") : undefined;
}

function pushWrapped(lines: string[], text: string, width: number, prefix = "", continuationPrefix = prefix): void {
	const segments = text.split("\n");
	for (const [index, segment] of segments.entries()) {
		if (!segment.trim()) {
			lines.push("");
			continue;
		}
		const wrapped = wrapTextWithAnsi(`${index === 0 ? prefix : continuationPrefix}${segment}`, width);
		for (const line of wrapped) {
			lines.push(truncateToWidth(line, width));
		}
	}
}

function pushQuestion(lines: string[], question: Question, _index: number, width: number, theme: Theme): void {
	pushWrapped(lines, question.question, width, theme.fg("text", ""));
	const meta = [questionTypeLabel(question.type)];
	const constraints = questionConstraintSummary(question);
	if (constraints) meta.push(constraints);
	if (question.allowOther) meta.push("other ok");
	pushWrapped(lines, meta.join(" • "), width, theme.fg("muted", "   "));
	if (question.context) pushWrapped(lines, question.context, width, theme.fg("dim", "   context: "));
	if (question.answerInstructions) pushWrapped(lines, question.answerInstructions, width, theme.fg("dim", "   answer: "));
	if (question.type !== QuestionType.TEXT) {
		for (const [optionIndex, option] of question.options.entries()) {
			pushWrapped(lines, `${optionIndex + 1}. ${option.label}`, width, theme.fg("text", "   - "));
			if (option.description) pushWrapped(lines, option.description, width, theme.fg("muted", "     "));
		}
		if (question.allowOther) {
			pushWrapped(lines, question.otherLabel ?? "Other", width, theme.fg("text", "   - "));
		}
	}
}

function pushListSelection(lines: string[], items: ListItem[], selectedIndex: number, width: number, theme: Theme): void {
	for (const [index, item] of items.entries()) {
		const selected = index === selectedIndex;
		const label = item.navLabel ?? item.title ?? `Item ${index + 1}`;
		const line = `${selected ? ">" : " "} ${label}`;
		lines.push(truncateToWidth(selected ? theme.fg("accent", line) : theme.fg("muted", line), width));
	}
	lines.push("");
	const selected = items[selectedIndex];
	if (!selected) return;
	if (selected.summary) {
		pushWrapped(lines, selected.summary, width, theme.fg("muted", ""));
		lines.push("");
	}
	pushWrapped(lines, selected.bodyMarkdown, width, theme.fg("text", ""));
}

function pushEmbeddedContent(lines: string[], content: EmbeddedContent, selectedNestedIndex: number, width: number, theme: Theme): void {
	if (content.type === EmbeddedContentType.MARKDOWN) {
		pushWrapped(lines, content.markdown ?? "", width, theme.fg("text", ""));
		return;
	}
	if (content.type === EmbeddedContentType.LIST) {
		pushListSelection(lines, content.items, Math.min(selectedNestedIndex, Math.max(0, content.items.length - 1)), width, theme);
		return;
	}
	for (const [index, question] of content.questions.entries()) {
		pushQuestion(lines, question, index, width, theme);
		if (index < content.questions.length - 1) lines.push("");
	}
}

function pushCollectionSelection(lines: string[], items: CollectionItem[], selectedIndex: number, nestedIndex: number, width: number, theme: Theme): void {
	for (const [index, item] of items.entries()) {
		const selected = index === selectedIndex;
		const label = item.navLabel ?? item.title ?? `View ${index + 1}`;
		const line = `${selected ? ">" : " "} ${label}`;
		lines.push(truncateToWidth(selected ? theme.fg("accent", line) : theme.fg("muted", line), width));
	}
	lines.push("");
	const selected = items[selectedIndex];
	if (!selected) return;
	if (selected.summary) {
		pushWrapped(lines, selected.summary, width, theme.fg("muted", ""));
		lines.push("");
	}
	pushEmbeddedContent(lines, selected.content, nestedIndex, width, theme);
}

function pushStoredAnswer(lines: string[], answer: StoredQuestionnaireAnswer | undefined, width: number, theme: Theme): void {
	if (!answer) return;
	lines.push(truncateToWidth(theme.fg("accent", "Saved answer"), width));
	if (answer.transcript) {
		pushWrapped(lines, answer.transcript, width, theme.fg("muted", ""));
		return;
	}
	const answered = answer.structuredAnswers?.filter((item) => item?.answered).length ?? 0;
	pushWrapped(lines, answered > 0 ? `${answered} answer(s) saved.` : "Answer saved.", width, theme.fg("muted", ""));
}

function countAnsweredCollectionItems(block: Block, runtime: RenderRuntime): number {
	if (block.type !== BlockType.COLLECTION) return 0;
	let count = 0;
	for (const item of block.collectionItems) {
		if (item.content.type !== EmbeddedContentType.QUESTIONNAIRE) continue;
		if (getStoredQuestionnaireAnswer(runtime, item.id)) count++;
	}
	return count;
}

function blockStatusLabel(block: Block, runtime: RenderRuntime): string | undefined {
	if (block.type === BlockType.QUESTIONNAIRE) {
		return getStoredQuestionnaireAnswer(runtime, block.id) ? "✓" : undefined;
	}
	if (block.type === BlockType.COLLECTION) {
		const answered = countAnsweredCollectionItems(block, runtime);
		return answered > 0 ? `✓ ${answered}` : undefined;
	}
	return undefined;
}

function currentItemIdsFromSelections(selections: Record<string, unknown>): Record<string, string> {
	const value = selections.activeItemIds;
	if (!isRecord(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, itemId] of Object.entries(value)) {
		if (typeof itemId === "string" && itemId.trim()) result[key] = itemId.trim();
	}
	return result;
}

function findSelectedBlockIndex(doc: RenderDoc, runtime: RenderRuntime): number {
	const activeBlockId = typeof runtime.selections.activeBlockId === "string" ? runtime.selections.activeBlockId : undefined;
	if (!activeBlockId) return 0;
	const index = doc.blocks.findIndex((block) => block.id === activeBlockId);
	return index >= 0 ? index : 0;
}

function clampIndex(index: number, size: number): number {
	if (size <= 0) return 0;
	return Math.max(0, Math.min(size - 1, index));
}

export class RenderViewerComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onDone: (result: RenderViewerResult) => void;
	private readonly doc: RenderDoc;
	private readonly runtime: RenderRuntime;
	private readonly title: string;
	private currentBlockIndex: number;
	private currentNestedIndexes: Record<string, number> = {};
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(session: RenderSession, tui: TUI, theme: Theme, onDone: (result: RenderViewerResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.onDone = onDone;
		const revision = getCurrentRenderRevision(session);
		this.doc = revision.doc;
		this.runtime = revision.runtime;
		this.title = getRenderSessionTitle(session);
		this.currentBlockIndex = findSelectedBlockIndex(this.doc, this.runtime);
		const activeItemIds = currentItemIdsFromSelections(this.runtime.selections);
		for (const block of this.doc.blocks) {
			if (block.type === BlockType.LIST) {
				const index = block.items.findIndex((item) => item.id === activeItemIds[block.id ?? ""]);
				this.currentNestedIndexes[block.id ?? ""] = index >= 0 ? index : 0;
			}
			if (block.type === BlockType.COLLECTION) {
				const index = block.collectionItems.findIndex((item) => item.id === activeItemIds[block.id ?? ""]);
				this.currentNestedIndexes[block.id ?? ""] = index >= 0 ? index : 0;
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private currentBlock(): Block {
		return this.doc.blocks[this.currentBlockIndex] ?? this.doc.blocks[0]!;
	}

	private currentNestedIndex(block: Block): number {
		return this.currentNestedIndexes[block.id ?? ""] ?? 0;
	}

	private moveBlock(delta: number): void {
		if (this.doc.blocks.length <= 1) return;
		this.currentBlockIndex = (this.currentBlockIndex + delta + this.doc.blocks.length) % this.doc.blocks.length;
		this.refresh();
	}

	private moveNested(delta: number): void {
		const block = this.currentBlock();
		const key = block.id ?? "";
		if (block.type === BlockType.LIST) {
			this.currentNestedIndexes[key] = clampIndex(this.currentNestedIndex(block) + delta, block.items.length);
			this.refresh();
			return;
		}
		if (block.type === BlockType.COLLECTION) {
			this.currentNestedIndexes[key] = clampIndex(this.currentNestedIndex(block) + delta, block.collectionItems.length);
			this.refresh();
		}
	}

	private currentQuestionnaire(): RenderQuestionnaireSelection | null {
		const currentBlock = this.currentBlock();
		if (currentBlock.type === BlockType.QUESTIONNAIRE) {
			return {
				key: currentBlock.id ?? `block-${this.currentBlockIndex}`,
				title: currentBlock.title,
				questions: currentBlock.questions,
			};
		}
		if (currentBlock.type !== BlockType.COLLECTION) return null;
		const selected = currentBlock.collectionItems[this.currentNestedIndex(currentBlock)];
		if (!selected || selected.content.type !== EmbeddedContentType.QUESTIONNAIRE) return null;
		return {
			key: selected.id ?? currentBlock.id ?? `block-${this.currentBlockIndex}`,
			title: selected.title ?? selected.navLabel ?? currentBlock.title,
			questions: selected.content.questions,
		};
	}

	private buildRuntime(): RenderRuntime {
		const currentBlock = this.currentBlock();
		const activeItemIds = currentItemIdsFromSelections(this.runtime.selections);
		if (currentBlock.type === BlockType.LIST) {
			const selected = currentBlock.items[this.currentNestedIndex(currentBlock)];
			if (selected?.id && currentBlock.id) activeItemIds[currentBlock.id] = selected.id;
		}
		if (currentBlock.type === BlockType.COLLECTION) {
			const selected = currentBlock.collectionItems[this.currentNestedIndex(currentBlock)];
			if (selected?.id && currentBlock.id) activeItemIds[currentBlock.id] = selected.id;
		}
		return {
			...this.runtime,
			selections: {
				...this.runtime.selections,
				activeBlockId: currentBlock.id,
				activeItemIds,
			},
		};
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.enter)) {
			this.onDone({ type: "close", runtime: this.buildRuntime() });
			return;
		}
		if (data === "a") {
			const questionnaire = this.currentQuestionnaire();
			if (questionnaire) {
				this.onDone({ type: "answer", runtime: this.buildRuntime(), questionnaire });
			}
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l") {
			this.moveBlock(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || data === "h") {
			this.moveBlock(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveNested(1);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveNested(-1);
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const lines: string[] = [];
		const current = this.currentBlock();
		const nestedIndex = this.currentNestedIndex(current);
		const safeWidth = Math.max(20, width);

		lines.push(truncateToWidth(this.theme.bold(this.theme.fg("text", this.title)), safeWidth));
		const answeredSummary = answeredCountLabel(countStoredQuestionnaireAnswers(this.runtime));
		const subtitle = `${summarizeDoc(this.doc)}${answeredSummary ? ` • ${answeredSummary}` : ""}`;
		lines.push(truncateToWidth(this.theme.fg("dim", subtitle), safeWidth));
		if (this.doc.introMarkdown) {
			lines.push("");
			pushWrapped(lines, this.doc.introMarkdown, safeWidth, this.theme.fg("muted", ""));
		}
		lines.push("");
		for (const [index, block] of this.doc.blocks.entries()) {
			const selected = index === this.currentBlockIndex;
			const status = blockStatusLabel(block, this.runtime);
			const line = `${selected ? ">" : " "} ${blockLabel(block)}${status ? `  ${status}` : ""}`;
			lines.push(truncateToWidth(selected ? this.theme.fg("accent", line) : this.theme.fg("muted", line), safeWidth));
		}
		lines.push("");
		if (current.type === BlockType.MARKDOWN) {
			pushWrapped(lines, current.markdown ?? "", safeWidth, this.theme.fg("text", ""));
		} else if (current.type === BlockType.LIST) {
			pushListSelection(lines, current.items, clampIndex(nestedIndex, current.items.length), safeWidth, this.theme);
		} else if (current.type === BlockType.QUESTIONNAIRE) {
			for (const [index, question] of current.questions.entries()) {
				pushQuestion(lines, question, index, safeWidth, this.theme);
				if (index < current.questions.length - 1) lines.push("");
			}
		} else {
			pushCollectionSelection(lines, current.collectionItems, clampIndex(nestedIndex, current.collectionItems.length), 0, safeWidth, this.theme);
		}
		const currentQuestionnaire = this.currentQuestionnaire();
		const storedAnswer = getStoredQuestionnaireAnswer(this.runtime, currentQuestionnaire?.key);
		if (storedAnswer) {
			lines.push("");
			pushStoredAnswer(lines, storedAnswer, safeWidth, this.theme);
		}
		lines.push("");
		const hints = ["Tab/←→ sections", "↑↓ move", "Enter/Esc close"];
		if (this.currentQuestionnaire()) hints.splice(2, 0, "a answer");
		lines.push(truncateToWidth(this.theme.fg("dim", hints.join(" • ")), safeWidth));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export function buildRenderMessageText(session: RenderSession, theme: Theme, expanded: boolean): string {
	const revision = getCurrentRenderRevision(session);
	const answeredSummary = answeredCountLabel(countStoredQuestionnaireAnswers(revision.runtime));
	const header = `${theme.fg("toolTitle", theme.bold("render "))}${theme.fg("text", getRenderSessionTitle(session))}`;
	const meta = `${summarizeDoc(revision.doc)}${answeredSummary ? ` • ${answeredSummary}` : ""}`;
	if (!expanded) {
		return `${header}\n${theme.fg("dim", meta)}`;
	}
	const parts = [header, theme.fg("muted", meta)];
	for (const block of revision.doc.blocks) {
		const status = blockStatusLabel(block, revision.runtime);
		parts.push(`${blockLabel(block)}${status ? `  ${status}` : ""}${block.type === BlockType.MARKDOWN ? "" : ` • ${blockKindSummary(block)}`}`);
	}
	return parts.join("\n");
}

export function createRenderMessageComponent(session: RenderSession, theme: Theme, expanded: boolean): Component {
	return new Text(buildRenderMessageText(session, theme, expanded), 0, 0);
}
