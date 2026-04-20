import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@mariozechner/pi-tui";
import { BlockType, EmbeddedContentType, QuestionType, type Block, type CollectionItem, type EmbeddedContent, type ListItem, type Question, type RenderDoc } from "./baml_client/types";
import type { RenderRuntime, RenderSession } from "./core";
import { getCurrentRenderRevision, getRenderSessionSummary, getRenderSessionTitle } from "./session";

export interface RenderQuestionnaireSelection {
	key: string;
	title?: string;
	questions: Question[];
}

export type RenderViewerResult =
	| { type: "close"; runtime: RenderRuntime }
	| { type: "answer"; runtime: RenderRuntime; questionnaire: RenderQuestionnaireSelection };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function blockLabel(block: Block, index: number): string {
	return block.title?.trim() || `${index + 1}. ${block.type.toLowerCase()}`;
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
	if (block.type === BlockType.MARKDOWN) return "markdown";
	if (block.type === BlockType.LIST) return `list:${block.items.length}`;
	if (block.type === BlockType.QUESTIONNAIRE) return `questions:${block.questions.length}`;
	return `views:${block.collectionItems.length}`;
}

function summarizeDoc(doc: RenderDoc): string {
	return doc.blocks.map((block, index) => `${index + 1}:${blockKindSummary(block)}`).join(" • ");
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

function pushSectionTitle(lines: string[], title: string, width: number, theme: Theme): void {
	lines.push(truncateToWidth(theme.bold(theme.fg("accent", title)), width));
}

function pushQuestion(lines: string[], question: Question, index: number, width: number, theme: Theme): void {
	pushWrapped(lines, `${index + 1}. ${question.question}`, width, theme.fg("text", ""));
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
	pushSectionTitle(lines, "Items", width, theme);
	for (const [index, item] of items.entries()) {
		const selected = index === selectedIndex;
		const label = item.navLabel ?? item.title ?? `Item ${index + 1}`;
		const line = `${selected ? ">" : " "} ${index + 1}. ${label}`;
		lines.push(truncateToWidth(selected ? theme.fg("accent", line) : theme.fg("text", line), width));
	}
	lines.push("");
	const selected = items[selectedIndex];
	if (!selected) return;
	pushSectionTitle(lines, selected.title ?? selected.navLabel ?? `Item ${selectedIndex + 1}`, width, theme);
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
	pushSectionTitle(lines, "Questions", width, theme);
	for (const [index, question] of content.questions.entries()) {
		pushQuestion(lines, question, index, width, theme);
		if (index < content.questions.length - 1) lines.push("");
	}
}

function pushCollectionSelection(lines: string[], items: CollectionItem[], selectedIndex: number, nestedIndex: number, width: number, theme: Theme): void {
	pushSectionTitle(lines, "Views", width, theme);
	for (const [index, item] of items.entries()) {
		const selected = index === selectedIndex;
		const label = item.navLabel ?? item.title ?? `View ${index + 1}`;
		const line = `${selected ? ">" : " "} ${index + 1}. ${label}`;
		lines.push(truncateToWidth(selected ? theme.fg("accent", line) : theme.fg("text", line), width));
	}
	lines.push("");
	const selected = items[selectedIndex];
	if (!selected) return;
	pushSectionTitle(lines, selected.title ?? selected.navLabel ?? `View ${selectedIndex + 1}`, width, theme);
	if (selected.summary) {
		pushWrapped(lines, selected.summary, width, theme.fg("muted", ""));
		lines.push("");
	}
	pushEmbeddedContent(lines, selected.content, nestedIndex, width, theme);
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

		lines.push(truncateToWidth(this.theme.fg("accent", "─".repeat(safeWidth)), safeWidth));
		lines.push(truncateToWidth(this.theme.bold(this.theme.fg("text", this.title)), safeWidth));
		lines.push(truncateToWidth(this.theme.fg("muted", `${this.doc.blocks.length} blocks • ${summarizeDoc(this.doc)}`), safeWidth));
		if (this.doc.introMarkdown) {
			lines.push("");
			pushWrapped(lines, this.doc.introMarkdown, safeWidth, this.theme.fg("muted", ""));
		}
		lines.push("");
		pushSectionTitle(lines, "Blocks", safeWidth, this.theme);
		for (const [index, block] of this.doc.blocks.entries()) {
			const selected = index === this.currentBlockIndex;
			const line = `${selected ? ">" : " "} ${index + 1}. ${blockLabel(block, index)}`;
			lines.push(truncateToWidth(selected ? this.theme.fg("accent", line) : this.theme.fg("text", line), safeWidth));
		}
		lines.push("");
		pushSectionTitle(lines, blockLabel(current, this.currentBlockIndex), safeWidth, this.theme);
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
		lines.push("");
		const hints = ["Tab/←→ blocks", "↑↓ items", "Enter/Esc close"];
		if (this.currentQuestionnaire()) hints.splice(2, 0, "a answer");
		lines.push(truncateToWidth(this.theme.fg("dim", hints.join(" • ")), safeWidth));
		lines.push(truncateToWidth(this.theme.fg("accent", "─".repeat(safeWidth)), safeWidth));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export function buildRenderMessageText(session: RenderSession, theme: Theme, expanded: boolean): string {
	const revision = getCurrentRenderRevision(session);
	const header = `${theme.fg("toolTitle", theme.bold("render "))}${theme.fg("text", getRenderSessionSummary(session))}`;
	if (!expanded) {
		return `${header}\n${theme.fg("dim", summarizeDoc(revision.doc))}`;
	}
	const parts = [header, theme.fg("muted", `source ${session.source.entryId} • revision ${revision.number}`)];
	if (revision.doc.introMarkdown) parts.push(revision.doc.introMarkdown);
	for (const [index, block] of revision.doc.blocks.entries()) {
		parts.push(`${index + 1}. ${blockLabel(block, index)} • ${blockKindSummary(block)}`);
		if (block.type === BlockType.MARKDOWN && block.markdown) {
			parts.push(block.markdown);
		}
		if (block.type === BlockType.LIST) {
			parts.push(...block.items.map((item, itemIndex) => `  - ${itemIndex + 1}. ${item.title ?? item.navLabel ?? item.bodyMarkdown}`));
		}
		if (block.type === BlockType.QUESTIONNAIRE) {
			parts.push(...block.questions.map((question, questionIndex) => `  - Q${questionIndex + 1}: ${question.question}`));
		}
		if (block.type === BlockType.COLLECTION) {
			parts.push(...block.collectionItems.map((item, itemIndex) => `  - ${itemIndex + 1}. ${item.title ?? item.navLabel ?? "View"}`));
		}
	}
	return parts.join("\n\n");
}

export function createRenderMessageComponent(session: RenderSession, theme: Theme, expanded: boolean): Component {
	return new Text(buildRenderMessageText(session, theme, expanded), 0, 0);
}
