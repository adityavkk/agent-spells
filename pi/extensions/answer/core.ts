export const QUESTION_TYPE_VALUES = ["text", "single_choice", "multiple_choice"] as const;
export type QuestionType = (typeof QUESTION_TYPE_VALUES)[number];

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

export type RawOption = string | {
	label: string;
	value?: string | null;
	description?: string | null;
};

export interface RawQuestion {
	question: string;
	context?: string | null;
	type?: string | null;
	options?: RawOption[];
	allowOther?: boolean | null;
	otherLabel?: string | null;
	freeFormLabel?: string | null;
}

const PLACEHOLDER_OPTIONAL_TEXT = new Set(["n/a", "na", "none", "null", "undefined", "not applicable"]);

function normalizeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (PLACEHOLDER_OPTIONAL_TEXT.has(trimmed.toLowerCase())) return undefined;
	return trimmed;
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
	if ((type === "single_choice" || type === "multiple_choice") && options.length === 0) {
		type = "text";
	}

	const otherLabelSource = typeof candidate.otherLabel === "string"
		? candidate.otherLabel
		: typeof candidate.freeFormLabel === "string"
			? candidate.freeFormLabel
			: "Other";

	return {
		question,
		context: normalizeOptionalText(candidate.context),
		type,
		options: type === "text" ? [] : options,
		allowOther: type !== "text" && candidate.allowOther === true,
		otherLabel: otherLabelSource.trim() || "Other",
	};
}

export function questionAnswered(question: ExtractedQuestion, answer: AnswerState): boolean {
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

export function formatAnswer(question: ExtractedQuestion, answer: AnswerState): string {
	if (!questionAnswered(question, answer)) {
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
