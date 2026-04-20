import type { AnswerSubmission, ExtractedQuestion, QuestionType as AnswerQuestionType } from "../answer/core";
import { QuestionType, type Question } from "./baml_client/types";
import type { RenderRuntime } from "./core";

function toAnswerQuestionType(type: QuestionType): AnswerQuestionType {
	switch (type) {
		case QuestionType.SINGLE_CHOICE:
			return "single_choice";
		case QuestionType.MULTIPLE_CHOICE:
			return "multiple_choice";
		case QuestionType.RANKING:
			return "ranking";
		default:
			return "text";
	}
}

export function toRenderAnswerQuestions(questions: Question[]): ExtractedQuestion[] {
	return questions.map((question) => ({
		question: question.question,
		context: question.context ?? undefined,
		type: toAnswerQuestionType(question.type),
		options: question.options.map((option) => ({
			label: option.label,
			value: option.value ?? undefined,
			description: option.description ?? undefined,
		})),
		allowOther: question.allowOther,
		otherLabel: question.otherLabel ?? "Other",
		answerInstructions: question.answerInstructions ?? undefined,
		constraints: {
			minSelections: question.constraints?.minSelections ?? undefined,
			maxSelections: question.constraints?.maxSelections ?? undefined,
			minSentences: question.constraints?.minSentences ?? undefined,
			maxSentences: question.constraints?.maxSentences ?? undefined,
		},
	}));
}

export function applyQuestionnaireAnswers(runtime: RenderRuntime, questionnaireKey: string, title: string | undefined, submission: AnswerSubmission): RenderRuntime {
	return {
		...runtime,
		answers: {
			...runtime.answers,
			[questionnaireKey]: {
				title,
				transcript: submission.transcript,
				structuredAnswers: submission.structuredAnswers,
				submittedAt: Date.now(),
			},
		},
	};
}

export function buildRenderAnswersMessage(title: string | undefined, submission: AnswerSubmission): {
	content: string;
	details: {
		title?: string;
		answers: AnswerSubmission["structuredAnswers"];
		transcript: string;
	};
} {
	const prefix = title ? `I answered your questions from ${title} in the following way:` : "I answered your questions in the following way:";
	return {
		content: `${prefix}\n\n${submission.transcript}`,
		details: {
			title,
			answers: submission.structuredAnswers,
			transcript: submission.transcript,
		},
	};
}
