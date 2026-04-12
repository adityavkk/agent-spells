import { describe, expect, it } from "bun:test";
import {
	buildAnswersMessage,
	formatAnswer,
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
		})).toEqual({
			question: "Pick a base",
			type: "single_choice",
			options: [
				{ label: "Rice", value: "rice" },
				{ label: "Salad", value: "Salad", description: "Light" },
			],
			allowOther: true,
			otherLabel: "Other",
		});
	});

	it("forces text questions to keep no options and no other toggle", () => {
		expect(normalizeQuestion({
			question: "Any dietary restrictions?",
			type: "TEXT",
			options: ["Should be ignored"],
			allowOther: true,
		})).toEqual({
			question: "Any dietary restrictions?",
			type: "text",
			options: [],
			allowOther: false,
			otherLabel: "Other",
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
		},
		{
			question: "Pick toppings",
			context: "Select all that apply.",
			type: "multiple_choice" as const,
			options: [
				{ label: "Chicken", value: "chicken" },
				{ label: "Beans", value: "beans" },
				{ label: "Cheese", value: "cheese" },
			],
			allowOther: true,
			otherLabel: "Other topping",
		},
		{
			question: "Anything else?",
			type: "text" as const,
			options: [],
			allowOther: false,
			otherLabel: "Other",
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
			selectedOptionIndexes: [0, 2],
			otherSelected: true,
			otherText: "Pickled onions",
		})).toBe("1. Chicken, 3. Cheese, Other topping: Pickled onions");
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
				selectedOptionIndexes: [1, 2],
				otherSelected: true,
				otherText: "Roasted corn",
			},
			{
				text: "Extra spicy",
				selectedOptionIndexes: [],
				otherSelected: false,
				otherText: "",
			},
		])).toBe([
			"Q: Choose a base",
			"A: Custom base: Quinoa",
			"",
			"Q: Pick toppings",
			"> Select all that apply.",
			"A: 2. Beans, 3. Cheese, Other topping: Roasted corn",
			"",
			"Q: Anything else?",
			"A: Extra spicy",
		].join("\n"));
	});
});
