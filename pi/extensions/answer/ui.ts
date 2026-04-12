import type { Theme } from "@mariozechner/pi-coding-agent";
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
import {
	buildAnswerSubmission,
	describeQuestionConstraints,
	formatAnswer,
	getAnswerValidationMessage,
	questionAnswered,
	type AnswerState,
	type AnswerSubmission,
	type ExtractedQuestion,
} from "./core";

export class AnswerComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: AnswerState[];
	private currentIndex = 0;
	private cursorIndex = 0;
	private editorTarget: "question" | "other" | null = null;
	private editor: Editor;
	private tui: TUI;
	private theme: Theme;
	private onDone: (result: AnswerSubmission | null) => void;
	private showingConfirmation = false;
	private validationMessage?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		theme: Theme,
		onDone: (result: AnswerSubmission | null) => void,
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
			this.validationMessage = undefined;
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
			case "ranking":
				return "Rank all";
			default:
				return "Free form";
		}
	}

	private syncForCurrentQuestion(): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		this.showingConfirmation = false;
		this.validationMessage = undefined;

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
		return questionAnswered(this.questions[index]!, this.answers[index]!);
	}

	private unansweredCount(): number {
		this.saveCurrentEditorText();
		let count = 0;
		for (let i = 0; i < this.questions.length; i++) {
			if (!this.questionAnswered(i)) count++;
		}
		return count;
	}

	private currentValidationMessage(): string | undefined {
		this.saveCurrentEditorText();
		return getAnswerValidationMessage(this.currentQuestion(), this.currentAnswer());
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

		this.validationMessage = undefined;
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
			const otherCount = question.allowOther && answer.otherSelected ? 1 : 0;
			const nextCount = answer.selectedOptionIndexes.length + otherCount + 1;
			if (question.constraints.maxSelections !== undefined && nextCount > question.constraints.maxSelections) {
				this.validationMessage = `Choose no more than ${question.constraints.maxSelections}`;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			answer.selectedOptionIndexes.push(index);
			answer.selectedOptionIndexes.sort((a, b) => a - b);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleRankingChoice(index: number): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		if (question.type !== "ranking") return;

		this.validationMessage = undefined;
		const existingIndex = answer.selectedOptionIndexes.indexOf(index);
		if (existingIndex >= 0) {
			answer.selectedOptionIndexes.splice(existingIndex, 1);
		} else {
			answer.selectedOptionIndexes.push(index);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private selectSingleChoice(index: number): void {
		const question = this.currentQuestion();
		const answer = this.currentAnswer();
		if (question.type !== "single_choice") return;

		this.validationMessage = undefined;
		if (question.allowOther && index === this.otherIndex(question)) {
			this.openOtherEditor();
			return;
		}

		answer.selectedOptionIndexes = [index];
		answer.otherSelected = false;
		this.editorTarget = null;
		this.editor.setText("");
		this.advanceOrConfirm();
	}

	private advanceOrConfirm(): void {
		this.saveCurrentEditorText();
		const validationMessage = this.currentValidationMessage();
		if (validationMessage) {
			this.validationMessage = validationMessage;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.currentIndex < this.questions.length - 1) {
			this.navigateTo(this.currentIndex + 1);
		} else {
			this.showingConfirmation = true;
			this.validationMessage = undefined;
			this.invalidate();
		}
		this.tui.requestRender();
	}

	private submit(): void {
		this.saveCurrentEditorText();
		this.onDone(buildAnswerSubmission(this.questions, this.answers));
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
		const rankIndex = question.type === "ranking"
			? answer.selectedOptionIndexes.indexOf(optionIndex)
			: -1;
		const isSelected = isOther
			? answer.otherSelected
			: question.type === "ranking"
				? rankIndex >= 0
				: answer.selectedOptionIndexes.includes(optionIndex);
		const unchecked = question.type === "single_choice"
			? "○"
			: question.type === "ranking"
				? "[ ]"
				: "☐";
		const checked = question.type === "single_choice"
			? "◉"
			: question.type === "ranking"
				? `[${rankIndex + 1}]`
				: "☑";
		const icon = isSelected
			? this.theme.fg("success", checked)
			: isCurrent
				? this.theme.fg("accent", unchecked)
				: this.theme.fg("dim", unchecked);
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
			const formatted = formatAnswer(question, answer);
			const otherPrefix = `${question.otherLabel}: `;
			const previewText = formatted.includes(otherPrefix)
				? formatted.slice(formatted.indexOf(otherPrefix) + otherPrefix.length)
				: answer.otherText.trim();
			
			const preview = wrapTextWithAnsi(
				this.theme.fg("muted", `↳ ${previewText}`),
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

		if (question.type === "ranking") {
			if (matchesKey(data, Key.space)) {
				this.toggleRankingChoice(this.cursorIndex);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (this.questionAnswered(this.currentIndex)) {
					this.advanceOrConfirm();
					return;
				}
				this.toggleRankingChoice(this.cursorIndex);
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

		const questionRules = describeQuestionConstraints(question);
		if (questionRules.length > 0) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const rule of questionRules) {
				for (const line of wrapTextWithAnsi(this.theme.fg("muted", `• ${rule}`), Math.max(8, contentWidth - 2))) {
					lines.push(padToWidth(boxLine(line)));
				}
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		if (question.type === "text") {
			lines.push(padToWidth(boxLine(this.theme.fg("muted", "Your answer"))));
			this.renderEditorBlock(lines, contentWidth, boxLine);
		} else {
			const hint = question.type === "single_choice"
				? this.theme.fg("muted", "Choose one option")
				: question.type === "ranking"
					? this.theme.fg("muted", "Press Space in rank order, then Enter to continue")
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

		if (this.validationMessage) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(this.theme.fg("warning", this.validationMessage), Math.max(8, contentWidth))) {
				lines.push(padToWidth(boxLine(line)));
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
			} else if (question.type === "ranking") {
				controls = `${this.theme.fg("dim", "↑↓")} move · ${this.theme.fg("dim", "Space")} rank/remove · ${this.theme.fg("dim", "Enter")} next/rank · ${this.theme.fg("dim", "Tab")} move · ${this.theme.fg("dim", "Esc")} cancel`;
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
