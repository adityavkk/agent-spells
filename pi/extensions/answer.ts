/**
 * Q&A extraction hook - extracts structured questions from assistant responses
 * and presents a richer answer UI with free-form, single-choice, and
 * multiple-choice questions.
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, Theme } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const QUESTION_TYPE_VALUES = ["text", "single_choice", "multiple_choice"] as const;
type QuestionType = (typeof QUESTION_TYPE_VALUES)[number];

const ExtractedOptionSchema = Type.Object({
	label: Type.String(),
	value: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
}, { additionalProperties: false });
type ExtractedOption = Static<typeof ExtractedOptionSchema>;

const ExtractedQuestionSchema = Type.Object({
	question: Type.String(),
	context: Type.Optional(Type.String()),
	type: Type.Union(QUESTION_TYPE_VALUES.map((value) => Type.Literal(value))),
	options: Type.Array(ExtractedOptionSchema),
	allowOther: Type.Boolean(),
	otherLabel: Type.String(),
}, { additionalProperties: false });
type ExtractedQuestion = Static<typeof ExtractedQuestionSchema>;

const ExtractionResultSchema = Type.Object({
	questions: Type.Array(ExtractedQuestionSchema),
}, { additionalProperties: false });
type ExtractionResult = Static<typeof ExtractionResultSchema>;

const RawOptionSchema = Type.Union([
	Type.String(),
	Type.Object({
		label: Type.String(),
		value: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
	}, { additionalProperties: true }),
]);
type RawOption = Static<typeof RawOptionSchema>;

const RawQuestionSchema = Type.Object({
	question: Type.String(),
	context: Type.Optional(Type.String()),
	type: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(RawOptionSchema)),
	allowOther: Type.Optional(Type.Boolean()),
	otherLabel: Type.Optional(Type.String()),
	freeFormLabel: Type.Optional(Type.String()),
}, { additionalProperties: true });
type RawQuestion = Static<typeof RawQuestionSchema>;

const RawExtractionResultSchema = Type.Object({
	questions: Type.Array(RawQuestionSchema),
}, { additionalProperties: true });
type RawExtractionResult = Static<typeof RawExtractionResultSchema>;

interface ExtractionUiResult {
	status: "success" | "cancelled" | "error";
	result?: ExtractionResult | null;
	message?: string;
}

interface AnswerState {
	text: string;
	selectedOptionIndexes: number[];
	otherSelected: boolean;
	otherText: string;
}

const SYSTEM_PROMPT = `You are a questionnaire extractor. Given text from a conversation, extract every question that needs user input and return a single JSON object.

Output JSON with exactly this shape:
{
  "questions": [
    {
      "question": "Question text",
      "context": "Optional context that helps the user answer",
      "type": "text | single_choice | multiple_choice",
      "options": [
        {
          "label": "Option label",
          "value": "stable_value",
          "description": "Optional short helper text"
        }
      ],
      "allowOther": true,
      "otherLabel": "Other"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Use type "text" for open-ended questions or whenever options are unclear
- Use type "single_choice" only when exactly one option should be chosen
- Use type "multiple_choice" only when multiple selections are allowed, for example "select all that apply"
- For choice questions, include options only when they are explicit or strongly implied by the text
- Never invent options that are not present in the source text
- If options are ambiguous, fall back to type "text"
- Set allowOther to true only when a free-form answer should be allowed in addition to the listed options
- Omit or leave options empty for text questions
- Keep question and option labels concise
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "Which database should we use?",
      "context": "Only MySQL and PostgreSQL are implemented right now.",
      "type": "single_choice",
      "options": [
        { "label": "PostgreSQL", "value": "postgres" },
        { "label": "MySQL", "value": "mysql" }
      ],
      "allowOther": true,
      "otherLabel": "Other"
    },
    {
      "question": "Which surfaces should ship in v1?",
      "type": "multiple_choice",
      "options": [
        { "label": "CLI", "value": "cli" },
        { "label": "TUI", "value": "tui" },
        { "label": "Web", "value": "web" }
      ],
      "allowOther": true,
      "otherLabel": "Other"
    },
    {
      "question": "Anything else we should consider?",
      "type": "text",
      "options": []
    }
  ]
}`;

const OLLAMA_PROVIDER = "ollama";
const GEMMA_MODEL_ID = "gemma4:e4b";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const gemmaModel = modelRegistry.find(OLLAMA_PROVIDER, GEMMA_MODEL_ID);
	if (gemmaModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(gemmaModel);
		if (auth.ok) {
			return gemmaModel;
		}
	}

	return currentModel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRawOption(value: unknown): value is RawOption {
	if (typeof value === "string") return true;
	if (!isRecord(value)) return false;
	if (typeof value.label !== "string") return false;
	if (value.value !== undefined && typeof value.value !== "string") return false;
	if (value.description !== undefined && typeof value.description !== "string") return false;
	return true;
}

function isRawQuestion(value: unknown): value is RawQuestion {
	if (!isRecord(value)) return false;
	if (typeof value.question !== "string") return false;
	if (value.context !== undefined && typeof value.context !== "string") return false;
	if (value.type !== undefined && typeof value.type !== "string") return false;
	if (value.allowOther !== undefined && typeof value.allowOther !== "boolean") return false;
	if (value.otherLabel !== undefined && typeof value.otherLabel !== "string") return false;
	if (value.freeFormLabel !== undefined && typeof value.freeFormLabel !== "string") return false;
	if (value.options !== undefined) {
		if (!Array.isArray(value.options)) return false;
		if (!value.options.every((option) => isRawOption(option))) return false;
	}
	return true;
}

function isRawExtractionResult(value: unknown): value is RawExtractionResult {
	if (!isRecord(value)) return false;
	if (!Array.isArray(value.questions)) return false;
	return value.questions.every((question) => isRawQuestion(question));
}

function normalizeQuestionType(value: unknown): QuestionType | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["text", "freeform", "free_form", "free-form", "open", "open_ended"].includes(normalized)) {
		return "text";
	}
	if (["single_choice", "single-choice", "single choice", "singlechoice", "single"].includes(normalized)) {
		return "single_choice";
	}
	if (["multiple_choice", "multiple-choice", "multiple choice", "multiplechoice", "multiple", "multi", "multi_select", "multi-select"].includes(normalized)) {
		return "multiple_choice";
	}
	return undefined;
}

function normalizeOption(value: RawOption): ExtractedOption | null {
	if (typeof value === "string") {
		const label = value.trim();
		return label ? { label, value: label } : null;
	}
	if (!value || typeof value !== "object") return null;

	const candidate = value as { label?: unknown; value?: unknown; description?: unknown };
	const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
	if (!label) return null;

	const option: ExtractedOption = {
		label,
		value: typeof candidate.value === "string" && candidate.value.trim() ? candidate.value.trim() : label,
	};
	if (typeof candidate.description === "string" && candidate.description.trim()) {
		option.description = candidate.description.trim();
	}
	return option;
}

function normalizeQuestion(candidate: RawQuestion): ExtractedQuestion | null {
	const question = candidate.question.trim();
	if (!question) return null;

	const options = Array.isArray(candidate.options)
		? candidate.options.map(normalizeOption).filter((option): option is ExtractedOption => option !== null)
		: [];

	let type = normalizeQuestionType(candidate.type);
	if (!type) {
		type = options.length > 0 ? "single_choice" : "text";
	}
	if ((type === "single_choice" || type === "multiple_choice") && options.length === 0) {
		type = "text";
	}

	const otherLabelSource = typeof candidate.otherLabel === "string"
		? candidate.otherLabel
		: typeof candidate.freeFormLabel === "string"
			? candidate.freeFormLabel
			: "Other";
	const otherLabel = otherLabelSource.trim() || "Other";

	return {
		question,
		context: typeof candidate.context === "string" && candidate.context.trim() ? candidate.context.trim() : undefined,
		type,
		options,
		allowOther: type !== "text" && candidate.allowOther === true,
		otherLabel,
	};
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed: unknown = JSON.parse(jsonStr);
		if (!isRawExtractionResult(parsed)) return null;

		return {
			questions: parsed.questions
				.map(normalizeQuestion)
				.filter((question): question is ExtractedQuestion => question !== null),
		};
	} catch {
		return null;
	}
}

class AnswerComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: AnswerState[];
	private currentIndex = 0;
	private cursorIndex = 0;
	private editorTarget: "question" | "other" | null = null;
	private editor: Editor;
	private tui: TUI;
	private theme: Theme;
	private onDone: (result: string | null) => void;
	private showingConfirmation = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		theme: Theme,
		onDone: (result: string | null) => void,
	) {
		this.questions = questions;
		this.answers = questions.map(() => ({
			text: "",
			selectedOptionIndexes: [],
			otherSelected: false,
			otherText: "",
		}));
		this.tui = tui;
		this.theme = theme;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => this.theme.fg("borderAccent", s),
			selectList: {
				selectedBg: (s: string) => this.theme.bg("selectedBg", s),
				matchHighlight: (s: string) => this.theme.fg("accent", s),
				itemSecondary: (s: string) => this.theme.fg("muted", s),
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};

		this.syncForCurrentQuestion();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private currentQuestion(): ExtractedQuestion {
		return this.questions[this.currentIndex]!;
	}

	private currentAnswer(): AnswerState {
		return this.answers[this.currentIndex]!;
	}

	private otherIndex(question: ExtractedQuestion): number {
		return question.options.length;
	}

	private isEditing(): boolean {
		const question = this.currentQuestion();
		return question.type === "text" || this.editorTarget === "other";
	}

	private questionKindLabel(question: ExtractedQuestion): string {
		switch (question.type) {
			case "single_choice":
				return "Pick one";
			case "multiple_choice":
				return "Pick any";
			default:
				return "Free form";
		}
	}

	private syncForCurrentQuestion(): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		this.showingConfirmation = false;

		if (question.type === "text") {
			this.editorTarget = "question";
			this.editor.setText(answer.text);
			this.cursorIndex = 0;
			return;
		}

		if (this.editorTarget === "other" && answer.otherSelected) {
			this.editor.setText(answer.otherText);
		} else {
			this.editorTarget = null;
			this.editor.setText("");
		}

		if (answer.otherSelected) {
			this.cursorIndex = this.otherIndex(question);
		} else if (answer.selectedOptionIndexes.length > 0) {
			this.cursorIndex = answer.selectedOptionIndexes[0]!;
		} else {
			this.cursorIndex = 0;
		}
	}

	private saveCurrentEditorText(): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		if (question.type === "text") {
			answer.text = this.editor.getText();
			return;
		}
		if (this.editorTarget === "other") {
			answer.otherText = this.editor.getText();
		}
	}

	private questionAnswered(index: number): boolean {
		const question = this.questions[index]!;
		const answer = this.answers[index]!;
		const otherFilled = answer.otherSelected && answer.otherText.trim().length > 0;

		switch (question.type) {
			case "text":
				return answer.text.trim().length > 0;
			case "single_choice":
				return answer.selectedOptionIndexes.length > 0 || otherFilled;
			case "multiple_choice":
				return answer.selectedOptionIndexes.length > 0 || otherFilled;
		}
	}

	private unansweredCount(): number {
		this.saveCurrentEditorText();
		let count = 0;
		for (let i = 0; i < this.questions.length; i++) {
			if (!this.questionAnswered(i)) count++;
		}
		return count;
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentEditorText();
		this.currentIndex = index;
		this.syncForCurrentQuestion();
		this.invalidate();
	}

	private moveQuestion(delta: number): void {
		const next = this.currentIndex + delta;
		if (next < 0 || next >= this.questions.length) return;
		this.navigateTo(next);
		this.tui.requestRender();
	}

	private moveCursor(delta: number): void {
		const question = this.currentQuestion();
		if (question.type === "text") return;
		const maxIndex = question.options.length + (question.allowOther ? 1 : 0) - 1;
		if (maxIndex < 0) return;
		this.cursorIndex = Math.max(0, Math.min(maxIndex, this.cursorIndex + delta));
		this.invalidate();
		this.tui.requestRender();
	}

	private openOtherEditor(): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		if (question.type === "text" || !question.allowOther) return;
		if (question.type === "single_choice") {
			answer.selectedOptionIndexes = [];
		}
		answer.otherSelected = true;
		this.cursorIndex = this.otherIndex(question);
		this.editorTarget = "other";
		this.editor.setText(answer.otherText);
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleMultiChoice(index: number): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		if (question.type !== "multiple_choice") return;

		if (question.allowOther && index === this.otherIndex(question)) {
			answer.otherSelected = !answer.otherSelected;
			if (answer.otherSelected) {
				this.openOtherEditor();
			} else {
				if (this.editorTarget === "other") {
					this.editorTarget = null;
					this.editor.setText("");
				}
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		const existingIndex = answer.selectedOptionIndexes.indexOf(index);
		if (existingIndex >= 0) {
			answer.selectedOptionIndexes.splice(existingIndex, 1);
		} else {
			answer.selectedOptionIndexes.push(index);
			answer.selectedOptionIndexes.sort((a, b) => a - b);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private selectSingleChoice(index: number): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		if (question.type !== "single_choice") return;

		if (question.allowOther && index === this.otherIndex(question)) {
			this.openOtherEditor();
			return;
		}

		answer.selectedOptionIndexes = [index];
		answer.otherSelected = false;
		answer.otherText = answer.otherText;
		this.editorTarget = null;
		this.editor.setText("");
		this.advanceOrConfirm();
	}

	private advanceOrConfirm(): void {
		this.saveCurrentEditorText();
		if (this.currentIndex < this.questions.length - 1) {
			this.navigateTo(this.currentIndex + 1);
		} else {
			this.showingConfirmation = true;
			this.invalidate();
		}
		this.tui.requestRender();
	}

	private submit(): void {
		this.saveCurrentEditorText();
		const parts: string[] = [];

		for (let i = 0; i < this.questions.length; i++) {
			const question = this.questions[i]!;
			parts.push(`Q: ${question.question}`);
			if (question.context) {
				parts.push(`> ${question.context}`);
			}
			parts.push(`A: ${this.formatAnswer(i)}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private formatAnswer(index: number): string {
		const question = this.questions[index]!;
		const answer = this.answers[index]!;

		if (!this.questionAnswered(index)) {
			return "(no answer)";
		}

		if (question.type === "text") {
			return answer.text.trim();
		}

		const selected = answer.selectedOptionIndexes
			.map((optionIndex) => {
				const option = question.options[optionIndex];
				return option ? `${optionIndex + 1}. ${option.label}` : null;
			})
			.filter((value): value is string => value !== null);

		if (answer.otherSelected && answer.otherText.trim()) {
			selected.push(`${question.otherLabel}: ${answer.otherText.trim()}`);
		}

		return selected.length > 0 ? selected.join(", ") : "(no answer)";
	}

	private cancel(): void {
		this.onDone(null);
	}

	private renderEditorBlock(lines: string[], width: number, boxLine: (content: string, leftPad?: number) => string): void {
		const editorWidth = Math.max(12, width - 6);
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			lines.push(boxLine(editorLines[i]!, 4));
		}
	}

	private renderChoiceOption(lines: string[], question: ExtractedQuestion, optionIndex: number, contentWidth: number, boxLine: (content: string, leftPad?: number) => string): void {
		const answer = this.currentAnswer();
		const isOther = question.allowOther && optionIndex === this.otherIndex(question);
		const option = isOther
			? { label: question.otherLabel, description: "Write your own answer" }
			: question.options[optionIndex]!;
		const isCurrent = this.cursorIndex === optionIndex;
		const isSelected = isOther
			? answer.otherSelected
			: answer.selectedOptionIndexes.includes(optionIndex);
		const unchecked = question.type === "single_choice" ? "○" : "☐";
		const checked = question.type === "single_choice" ? "◉" : "☑";
		const icon = isSelected ? this.theme.fg("success", checked) : isCurrent ? this.theme.fg("accent", unchecked) : this.theme.fg("dim", unchecked);
		const pointer = isCurrent ? this.theme.fg("accent", "›") : " ";
		const labelBase = isSelected ? this.theme.bold(option.label) : option.label;
		const label = isCurrent ? this.theme.fg("accent", labelBase) : this.theme.fg("text", labelBase);
		const wrapped = wrapTextWithAnsi(`${pointer} ${icon} ${label}`, Math.max(12, contentWidth));
		for (const line of wrapped) {
			lines.push(boxLine(line));
		}

		if (option.description) {
			const desc = wrapTextWithAnsi(this.theme.fg("muted", option.description), Math.max(8, contentWidth - 4));
			for (const line of desc) {
				lines.push(boxLine(line, 6));
			}
		}

		if (isOther && answer.otherSelected && answer.otherText.trim() && this.editorTarget !== "other") {
			const preview = wrapTextWithAnsi(
				this.theme.fg("muted", `↳ ${answer.otherText.trim()}`),
				Math.max(8, contentWidth - 4),
			);
			for (const line of preview) {
				lines.push(boxLine(line, 6));
			}
		}
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		const question = this.currentQuestion();
		const answer = this.currentAnswer();

		if (this.isEditing()) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				if (question.type === "text") {
					this.cancel();
				} else {
					this.saveCurrentEditorText();
					this.editorTarget = null;
					this.editor.setText("");
					this.invalidate();
					this.tui.requestRender();
				}
				return;
			}

			if (matchesKey(data, Key.tab)) {
				this.moveQuestion(1);
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				this.moveQuestion(-1);
				return;
			}

			if (question.type === "text") {
				if (matchesKey(data, Key.up) && this.editor.getText() === "") {
					this.moveQuestion(-1);
					return;
				}
				if (matchesKey(data, Key.down) && this.editor.getText() === "") {
					this.moveQuestion(1);
					return;
				}
			}

			if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
				this.saveCurrentEditorText();
				if (question.type === "multiple_choice" && this.editorTarget === "other") {
					this.editorTarget = null;
					this.editor.setText("");
					this.invalidate();
					this.tui.requestRender();
					return;
				}
				this.advanceOrConfirm();
				return;
			}

			this.editor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.moveQuestion(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.moveQuestion(-1);
			return;
		}

		if (question.type !== "text") {
			if (matchesKey(data, Key.up)) {
				this.moveCursor(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveCursor(1);
				return;
			}
		}

		if (question.type === "single_choice") {
			if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
				this.selectSingleChoice(this.cursorIndex);
			}
			return;
		}

		if (question.type === "multiple_choice") {
			if (matchesKey(data, Key.space)) {
				this.toggleMultiChoice(this.cursorIndex);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (question.allowOther && this.cursorIndex === this.otherIndex(question) && answer.otherSelected) {
					this.openOtherEditor();
					return;
				}
				if (this.questionAnswered(this.currentIndex)) {
					this.advanceOrConfirm();
					return;
				}
				this.toggleMultiChoice(this.cursorIndex);
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.max(12, Math.min(width, 120));
		const contentWidth = Math.max(8, boxWidth - 4);
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		const unanswered = this.unansweredCount();

		const horizontalLine = (count: number) => "─".repeat(Math.max(0, count));
		const border = (s: string) => this.theme.fg("borderMuted", s);
		const boxLine = (content: string, leftPad = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return border("│") + paddedContent + " ".repeat(rightPad) + border("│");
		};
		const emptyBoxLine = () => border("│") + " ".repeat(Math.max(0, boxWidth - 2)) + border("│");
		const padToWidth = (line: string): string => line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		lines.push(padToWidth(border(`╭${horizontalLine(boxWidth - 2)}╮`)));
		const title = `${this.theme.bold(this.theme.fg("accent", "Answer questions"))} ${this.theme.fg("dim", `(${this.currentIndex + 1}/${this.questions.length})`)}`;
		const answered = this.questions.length - unanswered;
		const summary = unanswered === 0
			? this.theme.fg("success", `${answered}/${this.questions.length} answered`)
			: `${this.theme.fg("success", `${answered}`)}/${this.questions.length} ${this.theme.fg("warning", `${unanswered} left`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(boxLine(summary)));
		lines.push(padToWidth(border(`├${horizontalLine(boxWidth - 2)}┤`)));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const label = ` ${i + 1} `;
			if (i === this.currentIndex) {
				progressParts.push(this.theme.bg("selectedBg", this.theme.fg("text", label)));
			} else if (this.questionAnswered(i)) {
				progressParts.push(this.theme.fg("success", `✓${i + 1}`));
			} else {
				progressParts.push(this.theme.fg("dim", label.trim()));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		const kind = this.theme.fg("accent", `[${this.questionKindLabel(question)}]`);
		for (const line of wrapTextWithAnsi(`${kind} ${this.theme.bold(question.question)}`, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}

		if (question.context) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(this.theme.fg("muted", `> ${question.context}`), Math.max(8, contentWidth - 1))) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		if (question.type === "text") {
			lines.push(padToWidth(boxLine(this.theme.fg("muted", "Your answer"))));
			this.renderEditorBlock(lines, contentWidth, boxLine);
		} else {
			const hint = question.type === "single_choice"
				? this.theme.fg("muted", "Choose one option")
				: this.theme.fg("muted", "Toggle any number of options");
			lines.push(padToWidth(boxLine(hint)));
			lines.push(padToWidth(emptyBoxLine()));

			for (let i = 0; i < question.options.length; i++) {
				this.renderChoiceOption(lines, question, i, contentWidth, boxLine);
			}
			if (question.allowOther) {
				this.renderChoiceOption(lines, question, this.otherIndex(question), contentWidth, boxLine);
			}

			if (this.editorTarget === "other") {
				lines.push(padToWidth(emptyBoxLine()));
				lines.push(padToWidth(boxLine(this.theme.fg("muted", `${question.otherLabel} details`))));
				this.renderEditorBlock(lines, contentWidth, boxLine);
			}
		}

		lines.push(padToWidth(emptyBoxLine()));
		lines.push(padToWidth(border(`├${horizontalLine(boxWidth - 2)}┤`)));

		if (this.showingConfirmation) {
			const confirmMsg = unanswered === 0
				? `${this.theme.fg("success", "Submit all answers?")} ${this.theme.fg("dim", "(Enter/y confirm, Esc/n back)")}`
				: `${this.theme.fg("warning", `Submit with ${unanswered} unanswered?`)} ${this.theme.fg("dim", "(Enter/y confirm, Esc/n back)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			let controls = "";
			if (question.type === "text") {
				controls = `${this.theme.fg("dim", "Enter")} next · ${this.theme.fg("dim", "Shift+Enter")} newline · ${this.theme.fg("dim", "Tab")} move · ${this.theme.fg("dim", "Esc")} cancel`;
			} else if (this.editorTarget === "other") {
				controls = question.type === "multiple_choice"
					? `${this.theme.fg("dim", "Enter")} save other · ${this.theme.fg("dim", "Shift+Enter")} newline · ${this.theme.fg("dim", "Tab")} move · ${this.theme.fg("dim", "Esc")} back`
					: `${this.theme.fg("dim", "Enter")} save + next · ${this.theme.fg("dim", "Shift+Enter")} newline · ${this.theme.fg("dim", "Tab")} move · ${this.theme.fg("dim", "Esc")} back`;
			} else if (question.type === "single_choice") {
				controls = `${this.theme.fg("dim", "↑↓")} move · ${this.theme.fg("dim", "Enter")} select · ${this.theme.fg("dim", "Tab")} move · ${this.theme.fg("dim", "Esc")} cancel`;
			} else {
				controls = `${this.theme.fg("dim", "↑↓")} move · ${this.theme.fg("dim", "Space")} toggle · ${this.theme.fg("dim", "Enter")} next/edit · ${this.theme.fg("dim", "Tab")} move · ${this.theme.fg("dim", "Esc")} cancel`;
			}
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}

		lines.push(padToWidth(border(`╰${horizontalLine(boxWidth - 2)}╯`)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
						.map((c: { type: "text"; text: string }) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						break;
					}
				}
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);
		const extractionModelLabel = `${extractionModel.provider}/${extractionModel.id}`;

		const extraction = await ctx.ui.custom<ExtractionUiResult>((tui: TUI, theme: Theme, _kb: unknown, done: (result: ExtractionUiResult) => void) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModelLabel}...`);
			loader.onAbort = () => done({ status: "cancelled" });

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal, temperature: 0 },
				);

				if (response.stopReason === "aborted") {
					return { status: "cancelled" } satisfies ExtractionUiResult;
				}

				const responseText = response.content
					.filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
					.map((c: { type: "text"; text: string }) => c.text)
					.join("\n");
				const parsed = parseExtractionResult(responseText);
				if (!parsed) {
					return {
						status: "error",
						message: `Model ${extractionModelLabel} returned invalid JSON for question extraction.`,
					} satisfies ExtractionUiResult;
				}

				return { status: "success", result: parsed } satisfies ExtractionUiResult;
			};

			doExtract()
				.then(done)
				.catch((error: unknown) => done({
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				}));

			return loader;
		});

		if (extraction.status === "cancelled") {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extraction.status === "error") {
			ctx.ui.notify(extraction.message ?? "Question extraction failed", "error");
			return;
		}

		const extractionResult = extraction.result!;
		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const answersResult = await ctx.ui.custom<string | null>((tui: TUI, theme: Theme, _kb: unknown, done: (result: string | null) => void) => {
			return new AnswerComponent(extractionResult.questions, tui, theme, done);
		});

		if (answersResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract structured questions from last assistant message into interactive Q&A",
		handler: (_args: string, ctx: ExtensionContext) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
