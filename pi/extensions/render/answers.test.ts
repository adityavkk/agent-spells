import { describe, expect, it } from "bun:test";
import { QuestionType } from "./baml_client/types";
import { applyQuestionnaireAnswers, buildRenderAnswersMessage, toRenderAnswerQuestions } from "./answers";

describe("render answers helpers", () => {
	it("converts render questions into answer questions", () => {
		const converted = toRenderAnswerQuestions([
			{
				id: "q1",
				type: QuestionType.MULTIPLE_CHOICE,
				question: "Pick owners",
				context: "Choose 1-2",
				options: [
					{ id: "api", label: "API", value: "api", description: "Backend" },
				],
				allowOther: true,
				otherLabel: "Other team",
				answerInstructions: "Keep it short",
				constraints: { minSelections: 1, maxSelections: 2 },
			},
		]);

		expect(converted).toEqual([
			expect.objectContaining({
				type: "multiple_choice",
				question: "Pick owners",
				allowOther: true,
				otherLabel: "Other team",
				constraints: { minSelections: 1, maxSelections: 2, minSentences: undefined, maxSentences: undefined },
			}),
		]);
	});

	it("stores questionnaire answers in runtime", () => {
		const runtime = applyQuestionnaireAnswers({
			renderSessionId: "render-1",
			sourceEntryId: "assistant-1",
			revision: 1,
			selections: {},
			answers: {},
			edits: {},
			branch: { mode: "none" },
		}, "questions", "Questions", {
			transcript: "Q: Pick owners\nA: API",
			answers: [],
			structuredAnswers: [{
				index: 1,
				question: "Pick owners",
				type: "multiple_choice",
				allowOther: false,
				otherLabel: "Other",
				constraints: {},
				answered: true,
				selectedOptions: [{ index: 1, label: "API" }],
			}],
		});

		expect(runtime.answers.questions).toEqual(expect.objectContaining({
			title: "Questions",
			transcript: "Q: Pick owners\nA: API",
		}));
	});

	it("builds a follow-up message for the assistant", () => {
		const message = buildRenderAnswersMessage("Questions", {
			transcript: "Q: Pick owners\nA: API",
			answers: [],
			structuredAnswers: [],
		});

		expect(message.content).toContain("I answered your questions from Questions");
		expect(message.content).toContain("Q: Pick owners");
		expect(message.details.title).toBe("Questions");
	});
});
