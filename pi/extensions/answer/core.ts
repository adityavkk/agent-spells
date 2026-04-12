export const QUESTION_TYPE_VALUES = ["text", "single_choice", "multiple_choice", "ranking"] as const;
export type QuestionType = (typeof QUESTION_TYPE_VALUES)[number];

export interface AnswerConstraints {
	minSelections?: number;
	maxSelections?: number;
	minSentences?: number;
	maxSentences?: number;
}

export interface ExtractedOption {
	label: string;
	value?: string;
	description?: string;
}

export interface ExtractedQuestion {
	question: string;
	context?: string;
	type: QuestionType;
	options: ExtractedOption[];
	allowOther: boolean;
	otherLabel: string;
	answerInstructions?: string;
	constraints: AnswerConstraints;
}

export interface ExtractionResult {
	questions: ExtractedQuestion[];
}

export interface ExtractionUiResult {
	status: "success" | "cancelled" | "error";
	result?: ExtractionResult | null;
	message?: string;
}

export interface AnswerState {
	text: string;
	selectedOptionIndexes: number[];
	otherSelected: boolean;
	otherText: string;
}

export interface StructuredAnswerSelection {
	index: number;
	label: string;
	value?: string;
	rank?: number;
}

export interface StructuredAnswer {
	index: number;
	question: string;
	context?: string;
	type: QuestionType;
	allowOther: boolean;
	otherLabel: string;
	answerInstructions?: string;
	constraints: AnswerConstraints;
	answered: boolean;
	validationMessage?: string;
	text?: string;
	selectedOptions: StructuredAnswerSelection[];
	other?: {
		label: string;
		text: string;
	};
}

export interface AnswerSubmission {
	transcript: string;
	answers: AnswerState[];
	structuredAnswers: StructuredAnswer[];
}

export type RawOption = string | {
	label: string;
	value?: string | null;
	description?: string | null;
};

export interface RawAnswerConstraints {
	minSelections?: number | null;
	maxSelections?: number | null;
	minSentences?: number | null;
	maxSentences?: number | null;
}

export interface RawQuestion {
	question: string;
	context?: string | null;
	type?: string | null;
	options?: RawOption[];
	allowOther?: boolean | null;
	otherLabel?: string | null;
	freeFormLabel?: string | null;
	answerInstructions?: string | null;
	constraints?: RawAnswerConstraints | null;
}

const PLACEHOLDER_OPTIONAL_TEXT = new Set(["n/a", "na", "none", "null", "undefined", "not applicable"]);

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

function normalizeConstraints(candidate: RawAnswerConstraints | null | undefined): AnswerConstraints {
	const constraints: AnswerConstraints = {};
	const minSelections = normalizePositiveInteger(candidate?.minSelections);
	const maxSelections = normalizePositiveInteger(candidate?.maxSelections);
	const minSentences = normalizePositiveInteger(candidate?.minSentences);
	const maxSentences = normalizePositiveInteger(candidate?.maxSentences);

	if (minSelections !== undefined) constraints.minSelections = minSelections;
	if (maxSelections !== undefined) constraints.maxSelections = maxSelections;
	if (minSentences !== undefined) constraints.minSentences = minSentences;
	if (maxSentences !== undefined) constraints.maxSentences = maxSentences;

	if (
		constraints.minSelections !== undefined
		&& constraints.maxSelections !== undefined
		&& constraints.minSelections > constraints.maxSelections
	) {
		constraints.maxSelections = constraints.minSelections;
	}

	if (
		constraints.minSentences !== undefined
		&& constraints.maxSentences !== undefined
		&& constraints.minSentences > constraints.maxSentences
	) {
		constraints.maxSentences = constraints.minSentences;
	}

	return constraints;
}

function countSentences(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed
		.split(/[.!?]+(?:\s+|$)/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0).length;
}

function otherFilled(answer: AnswerState): boolean {
	return answer.otherSelected && answer.otherText.trim().length > 0;
}

function selectedCount(question: ExtractedQuestion, answer: AnswerState): number {
	return answer.selectedOptionIndexes.length + (question.allowOther && otherFilled(answer) ? 1 : 0);
}

function selectionSummary(min?: number, max?: number): string | undefined {
	if (min !== undefined && max !== undefined) {
		if (min === max) return `Choose exactly ${min}`;
		return `Choose between ${min} and ${max}`;
	}
	if (min !== undefined) return `Choose at least ${min}`;
	if (max !== undefined) return `Choose up to ${max}`;
	return undefined;
}

function sentenceSummary(min?: number, max?: number): string | undefined {
	if (min !== undefined && max !== undefined) {
		if (min === max) return `Write exactly ${min} sentence${min === 1 ? "" : "s"}`;
		return `Write between ${min} and ${max} sentences`;
	}
	if (min !== undefined) return `Write at least ${min} sentence${min === 1 ? "" : "s"}`;
	if (max !== undefined) return `Write up to ${max} sentence${max === 1 ? "" : "s"}`;
	return undefined;
}

export function normalizeQuestionType(value: unknown): QuestionType | undefined {
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
	if (["ranking", "rank", "ordered", "order", "ranked_list", "ranked-list"].includes(normalized)) {
		return "ranking";
	}
	return undefined;
}

export function normalizeOption(value: RawOption): ExtractedOption | null {
	if (typeof value === "string") {
		const label = value.trim();
		return label ? { label, value: label } : null;
	}
	if (!value || typeof value !== "object") return null;

	const label = typeof value.label === "string" ? value.label.trim() : "";
	if (!label) return null;

	const option: ExtractedOption = {
		label,
		value: typeof value.value === "string" && value.value.trim() ? value.value.trim() : label,
	};
	const description = normalizeOptionalText(value.description);
	if (description) option.description = description;
	return option;
}

export function normalizeQuestion(candidate: RawQuestion): ExtractedQuestion | null {
	const question = candidate.question.trim();
	if (!question) return null;

	const options = Array.isArray(candidate.options)
		? candidate.options.map(normalizeOption).filter((option): option is ExtractedOption => option !== null)
		: [];

	let type = normalizeQuestionType(candidate.type);
	if (!type) type = options.length > 0 ? "single_choice" : "text";
	if ((type === "single_choice" || type === "multiple_choice" || type === "ranking") && options.length === 0) {
		type = "text";
	}

	const otherLabelSource = typeof candidate.otherLabel === "string"
		? candidate.otherLabel
		: typeof candidate.freeFormLabel === "string"
			? candidate.freeFormLabel
			: "Other";

	const constraints = normalizeConstraints(candidate.constraints);
	const allowOther = (type === "single_choice" || type === "multiple_choice") && candidate.allowOther === true;

	return {
		question,
		context: normalizeOptionalText(candidate.context),
		type,
		options: type === "text" ? [] : options,
		allowOther,
		otherLabel: otherLabelSource.trim() || "Other",
		answerInstructions: normalizeOptionalText(candidate.answerInstructions),
		constraints,
	};
}

export function describeQuestionConstraints(question: ExtractedQuestion): string[] {
	const descriptions: string[] = [];
	if (question.answerInstructions) descriptions.push(question.answerInstructions);

	if (question.type === "ranking") {
		descriptions.push(`Rank all ${question.options.length} options in order.`);
		return descriptions;
	}

	if (question.type === "text") {
		const summary = sentenceSummary(question.constraints.minSentences, question.constraints.maxSentences);
		if (summary) descriptions.push(summary + ".");
		return descriptions;
	}

	const summary = selectionSummary(question.constraints.minSelections, question.constraints.maxSelections);
	if (summary) descriptions.push(summary + ".");
	return descriptions;
}

export function getAnswerValidationMessage(question: ExtractedQuestion, answer: AnswerState): string | undefined {
	if (question.type === "text") {
		const text = answer.text.trim();
		if (!text) return "Answer required";

		const sentences = countSentences(text);
		const { minSentences, maxSentences } = question.constraints;
		if (minSentences !== undefined && sentences < minSentences) {
			return `Write at least ${minSentences} sentence${minSentences === 1 ? "" : "s"}`;
		}
		if (maxSentences !== undefined && sentences > maxSentences) {
			return `Write no more than ${maxSentences} sentence${maxSentences === 1 ? "" : "s"}`;
		}
		return undefined;
	}

	if (question.type === "ranking") {
		if (answer.selectedOptionIndexes.length < question.options.length) {
			return `Rank all ${question.options.length} options`;
		}
		return undefined;
	}

	if (question.allowOther && answer.otherSelected && answer.otherText.trim().length === 0) {
		return `Fill in ${question.otherLabel}`;
	}

	const count = selectedCount(question, answer);
	if (count === 0) {
		return question.type === "single_choice" ? "Choose one option" : "Choose at least one option";
	}

	const { minSelections, maxSelections } = question.constraints;
	if (minSelections !== undefined && count < minSelections) {
		return `Choose at least ${minSelections}`;
	}
	if (maxSelections !== undefined && count > maxSelections) {
		return `Choose no more than ${maxSelections}`;
	}
	return undefined;
}

export function questionAnswered(question: ExtractedQuestion, answer: AnswerState): boolean {
	return getAnswerValidationMessage(question, answer) === undefined;
}

export function formatAnswer(question: ExtractedQuestion, answer: AnswerState): string {
	if (!questionAnswered(question, answer)) {
		return "(no answer)";
	}

	if (question.type === "text") {
		return answer.text.trim();
	}

	if (question.type === "ranking") {
		return answer.selectedOptionIndexes
			.map((optionIndex, rankIndex) => {
				const option = question.options[optionIndex];
				return option ? `${rankIndex + 1}. ${option.label}` : null;
			})
			.filter((value): value is string => value !== null)
			.join(", ");
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

function cloneAnswer(answer: AnswerState): AnswerState {
	return {
		text: answer.text,
		selectedOptionIndexes: [...answer.selectedOptionIndexes],
		otherSelected: answer.otherSelected,
		otherText: answer.otherText,
	};
}

export function buildStructuredAnswers(questions: ExtractedQuestion[], answers: AnswerState[]): StructuredAnswer[] {
	return questions.map((question, index) => {
		const answer = answers[index]!;
		const validationMessage = getAnswerValidationMessage(question, answer);
		const selectedOptions = answer.selectedOptionIndexes
			.map((optionIndex, position) => {
				const option = question.options[optionIndex];
				if (!option) return null;
				return {
					index: optionIndex,
					label: option.label,
					value: option.value,
					rank: question.type === "ranking" ? position + 1 : undefined,
				} satisfies StructuredAnswerSelection;
			})
			.filter((option): option is StructuredAnswerSelection => option !== null);

		return {
			index,
			question: question.question,
			context: question.context,
			type: question.type,
			allowOther: question.allowOther,
			otherLabel: question.otherLabel,
			answerInstructions: question.answerInstructions,
			constraints: { ...question.constraints },
			answered: validationMessage === undefined,
			validationMessage,
			text: question.type === "text" ? answer.text.trim() : undefined,
			selectedOptions,
			other: question.allowOther && answer.otherSelected
				? {
					label: question.otherLabel,
					text: answer.otherText.trim(),
				}
				: undefined,
		};
	});
}

export function buildAnswersMessage(questions: ExtractedQuestion[], answers: AnswerState[]): string {
	const parts: string[] = [];

	for (let i = 0; i < questions.length; i++) {
		const question = questions[i]!;
		const answer = answers[i]!;
		parts.push(`Q: ${question.question}`);
		if (question.context) parts.push(`> ${question.context}`);
		parts.push(`A: ${formatAnswer(question, answer)}`);
		parts.push("");
	}

	return parts.join("\n").trim();
}

export function buildAnswerSubmission(questions: ExtractedQuestion[], answers: AnswerState[]): AnswerSubmission {
	const clonedAnswers = answers.map(cloneAnswer);
	return {
		transcript: buildAnswersMessage(questions, clonedAnswers),
		answers: clonedAnswers,
		structuredAnswers: buildStructuredAnswers(questions, clonedAnswers),
	};
}
