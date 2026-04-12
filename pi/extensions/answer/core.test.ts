import { describe, expect, it } from "bun:test";
import {
	buildAnswerSubmission,
	buildAnswersMessage,
	buildStructuredAnswers,
	formatAnswer,
	getAnswerValidationMessage,
	normalizeOption,
	normalizeQuestion,
	normalizeQuestionType,
	questionAnswered,
} from "./core";

describe("normalizeQuestionType", () => {
	it("maps known aliases", () => {
		expect(normalizeQuestionType("free-form")).toBe("text");
		expect(normalizeQuestionType("single choice")).toBe("single_choice");
		expect(normalizeQuestionType("multi-select")).toBe("multiple_choice");
		expect(normalizeQuestionType("ranking")).toBe("ranking");
		expect(normalizeQuestionType("SINGLE_CHOICE")).toBe("single_choice");
	});

	it("returns undefined for unknown values", () => {
		expect(normalizeQuestionType("dropdown")).toBeUndefined();
	});
});

describe("normalizeOption", () => {
	it("normalizes string options", () => {
		expect(normalizeOption("  Avocado  ")).toEqual({ label: "Avocado", value: "Avocado" });
	});

	it("drops empty labels and trims object fields", () => {
		expect(normalizeOption("   ")).toBeNull();
		expect(normalizeOption({ label: "  Olives ", value: "  olives ", description: "  salty  " })).toEqual({
			label: "Olives",
			value: "olives",
			description: "salty",
		});
	});
});

describe("normalizeQuestion", () => {
	it("normalizes nullable optional fields for tui safety", () => {
		expect(normalizeQuestion({
			question: "Pick a base",
			context: "N/A",
			type: "SINGLE_CHOICE",
			options: [
				{ label: "Rice", value: "rice", description: null },
				{ label: "Salad", value: null, description: "Light" },
			],
			allowOther: true,
			otherLabel: null,
			answerInstructions: "Choose one only",
			constraints: { minSelections: 1, maxSelections: 1 },
		})).toEqual({
			question: "Pick a base",
			type: "single_choice",
			options: [
				{ label: "Rice", value: "rice" },
				{ label: "Salad", value: "Salad", description: "Light" },
			],
			allowOther: true,
			otherLabel: "Other",
			answerInstructions: "Choose one only",
			constraints: { minSelections: 1, maxSelections: 1 },
		});
	});

	it("forces text questions to keep no options and no other toggle", () => {
		expect(normalizeQuestion({
			question: "Any dietary restrictions?",
			type: "TEXT",
			options: ["Should be ignored"],
			allowOther: true,
			constraints: { minSentences: 1, maxSentences: 3 },
		})).toEqual({
			question: "Any dietary restrictions?",
			type: "text",
			options: [],
			allowOther: false,
			otherLabel: "Other",
			constraints: { minSentences: 1, maxSentences: 3 },
		});
	});

	it("keeps ranking constraints declarative and disables other", () => {
		expect(normalizeQuestion({
			question: "Rank these priorities",
			type: "RANKING",
			options: ["Taste", "Price", "Speed"],
			allowOther: true,
			answerInstructions: "Rank 1-3",
			constraints: { minSelections: 3, maxSelections: 3 },
		})).toEqual({
			question: "Rank these priorities",
			type: "ranking",
			options: [
				{ label: "Taste", value: "Taste" },
				{ label: "Price", value: "Price" },
				{ label: "Speed", value: "Speed" },
			],
			allowOther: false,
			otherLabel: "Other",
			answerInstructions: "Rank 1-3",
			constraints: { minSelections: 3, maxSelections: 3 },
		});
	});
});

describe("answer serialization", () => {
	const questions = [
		{
			question: "Choose a base",
			type: "single_choice" as const,
			options: [
				{ label: "Rice", value: "rice" },
				{ label: "Salad", value: "salad" },
			],
			allowOther: true,
			otherLabel: "Custom base",
			constraints: { minSelections: 1, maxSelections: 1 },
		},
		{
			question: "Pick toppings",
			context: "Select up to two.",
			type: "multiple_choice" as const,
			options: [
				{ label: "Chicken", value: "chicken" },
				{ label: "Beans", value: "beans" },
				{ label: "Cheese", value: "cheese" },
			],
			allowOther: true,
			otherLabel: "Other topping",
			constraints: { maxSelections: 2 },
		},
		{
			question: "Rank these lunch priorities",
			type: "ranking" as const,
			options: [
				{ label: "Taste", value: "taste" },
				{ label: "Price", value: "price" },
				{ label: "Speed", value: "speed" },
			],
			allowOther: false,
			otherLabel: "Other",
			constraints: { minSelections: 3, maxSelections: 3 },
		},
		{
			question: "Anything else?",
			type: "text" as const,
			options: [],
			allowOther: false,
			otherLabel: "Other",
			constraints: { minSentences: 1, maxSentences: 3 },
		},
	];

	it("formats single-choice selections", () => {
		expect(formatAnswer(questions[0]!, {
			text: "",
			selectedOptionIndexes: [1],
			otherSelected: false,
			otherText: "",
		})).toBe("2. Salad");
	});

	it("formats multiple-choice selections plus free-form other text", () => {
		expect(formatAnswer(questions[1]!, {
			text: "",
			selectedOptionIndexes: [0],
			otherSelected: true,
			otherText: "Pickled onions",
		})).toBe("1. Chicken, Other topping: Pickled onions");
	});

	it("formats ranking selections in rank order", () => {
		expect(formatAnswer(questions[2]!, {
			text: "",
			selectedOptionIndexes: [2, 0, 1],
			otherSelected: false,
			otherText: "",
		})).toBe("1. Speed, 2. Taste, 3. Price");
	});

	it("treats other-without-text as unanswered", () => {
		const answer = {
			text: "",
			selectedOptionIndexes: [],
			otherSelected: true,
			otherText: "   ",
		};
		expect(questionAnswered(questions[1]!, answer)).toBeFalse();
		expect(formatAnswer(questions[1]!, answer)).toBe("(no answer)");
	});

	it("enforces selection and sentence constraints", () => {
		expect(getAnswerValidationMessage(questions[1]!, {
			text: "",
			selectedOptionIndexes: [0, 1],
			otherSelected: true,
			otherText: "Extra sauce",
		})).toBe("Choose no more than 2");

		expect(getAnswerValidationMessage(questions[3]!, {
			text: "One. Two. Three. Four.",
			selectedOptionIndexes: [],
			otherSelected: false,
			otherText: "",
		})).toBe("Write no more than 3 sentences");
	});

	it("builds full answer transcript for mixed question types", () => {
		expect(buildAnswersMessage(questions, [
			{
				text: "",
				selectedOptionIndexes: [],
				otherSelected: true,
				otherText: "Quinoa",
			},
			{
				text: "",
				selectedOptionIndexes: [1],
				otherSelected: true,
				otherText: "Roasted corn",
			},
			{
				text: "",
				selectedOptionIndexes: [1, 0, 2],
				otherSelected: false,
				otherText: "",
			},
			{
				text: "Extra spicy but balanced.",
				selectedOptionIndexes: [],
				otherSelected: false,
				otherText: "",
			},
		])).toBe([
			"Q: Choose a base",
			"A: Custom base: Quinoa",
			"",
			"Q: Pick toppings",
			"> Select up to two.",
			"A: 2. Beans, Other topping: Roasted corn",
			"",
			"Q: Rank these lunch priorities",
			"A: 1. Price, 2. Taste, 3. Speed",
			"",
			"Q: Anything else?",
			"A: Extra spicy but balanced.",
		].join("\n"));
	});

	it("builds structured answer details for downstream use", () => {
		const answers = [
			{
				text: "",
				selectedOptionIndexes: [1],
				otherSelected: false,
				otherText: "",
			},
			{
				text: "",
				selectedOptionIndexes: [0],
				otherSelected: true,
				otherText: "Hot honey",
			},
			{
				text: "",
				selectedOptionIndexes: [2, 0, 1],
				otherSelected: false,
				otherText: "",
			},
			{
				text: "Keep it simple.",
				selectedOptionIndexes: [],
				otherSelected: false,
				otherText: "",
			},
		];

		expect(buildStructuredAnswers(questions, answers)).toEqual([
			expect.objectContaining({
				index: 0,
				type: "single_choice",
				answered: true,
				selectedOptions: [{ index: 1, label: "Salad", value: "salad", rank: undefined }],
			}),
			expect.objectContaining({
				index: 1,
				type: "multiple_choice",
				answered: true,
				selectedOptions: [{ index: 0, label: "Chicken", value: "chicken", rank: undefined }],
				other: { label: "Other topping", text: "Hot honey" },
			}),
			expect.objectContaining({
				index: 2,
				type: "ranking",
				answered: true,
				selectedOptions: [
					{ index: 2, label: "Speed", value: "speed", rank: 1 },
					{ index: 0, label: "Taste", value: "taste", rank: 2 },
					{ index: 1, label: "Price", value: "price", rank: 3 },
				],
			}),
			expect.objectContaining({
				index: 3,
				type: "text",
				answered: true,
				text: "Keep it simple.",
			}),
		]);
	});

	it("builds transcript plus structured payload together", () => {
		const submission = buildAnswerSubmission(questions, [
			{
				text: "",
				selectedOptionIndexes: [0],
				otherSelected: false,
				otherText: "",
			},
			{
				text: "",
				selectedOptionIndexes: [1],
				otherSelected: false,
				otherText: "",
			},
			{
				text: "",
				selectedOptionIndexes: [0, 2, 1],
				otherSelected: false,
				otherText: "",
			},
			{
				text: "Done.",
				selectedOptionIndexes: [],
				otherSelected: false,
				otherText: "",
			},
		]);

		expect(submission.transcript).toContain("Q: Choose a base");
		expect(submission.structuredAnswers[2]?.selectedOptions[0]?.rank).toBe(1);
		expect(submission.answers[1]?.selectedOptionIndexes).toEqual([1]);
	});
});
