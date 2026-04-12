import { describe, expect, it } from "bun:test";
import { buildBamlExtractionContext, parseBamlExtractionResult } from "./extraction";

describe("answer extraction bridge", () => {
	it("renders pi transport context and normalizes parsed baml output for the tui", { timeout: 20_000 }, async () => {
		const context = await buildBamlExtractionContext("Ask one food question.");
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]!.role).toBe("user");
		expect(String(context.messages[0]!.content)).toContain("questionnaire extractor");
		expect(String(context.messages[0]!.content)).toContain("RANKING");
		expect(String(context.messages[0]!.content)).toContain("constraints");
		expect(String(context.messages[0]!.content)).toContain("Ask one food question.");

		const parsed = parseBamlExtractionResult([
			"```json",
			"{",
			'  "questions": [',
			"    {",
			'      "question": "What\'s your ideal spice level?",',
			'      "context": null,',
			'      "type": "TEXT",',
			'      "options": [],',
			'      "allowOther": false,',
			'      "otherLabel": null,',
			'      "answerInstructions": "Use 1-3 sentences.",',
			'      "constraints": { "minSentences": 1, "maxSentences": 3 }',
			"    },",
			"    {",
			'      "question": "Pick a base",',
			'      "context": "N/A",',
			'      "type": "SINGLE_CHOICE",',
			'      "options": [',
			'        { "label": "Rice", "value": "rice", "description": null },',
			'        { "label": "Salad", "value": null, "description": "Light" }',
			"      ],",
			'      "allowOther": true,',
			'      "otherLabel": "Custom base",',
			'      "answerInstructions": "Choose one only.",',
			'      "constraints": { "minSelections": 1, "maxSelections": 1 }',
			"    },",
			"    {",
			'      "question": "Pick toppings",',
			'      "context": null,',
			'      "type": "MULTIPLE_CHOICE",',
			'      "options": [',
			'        { "label": "Beans", "value": "beans", "description": null },',
			'        { "label": "Cheese", "value": null, "description": null }',
			"      ],",
			'      "allowOther": true,',
			'      "otherLabel": null,',
			'      "answerInstructions": "Choose up to 2.",',
			'      "constraints": { "maxSelections": 2 }',
			"    },",
			"    {",
			'      "question": "Rank lunch priorities",',
			'      "context": null,',
			'      "type": "RANKING",',
			'      "options": [',
			'        { "label": "Taste", "value": "taste", "description": null },',
			'        { "label": "Price", "value": "price", "description": null },',
			'        { "label": "Speed", "value": "speed", "description": null }',
			"      ],",
			'      "allowOther": false,',
			'      "otherLabel": null,',
			'      "answerInstructions": "Rank 1-3.",',
			'      "constraints": { "minSelections": 3, "maxSelections": 3 }',
			"    }",
			"  ]",
			"}",
			"```",
		].join("\n"));

		expect(parsed.questions).toHaveLength(4);
		expect(parsed.questions[0]).toEqual({
			question: "What's your ideal spice level?",
			type: "text",
			options: [],
			allowOther: false,
			otherLabel: "Other",
			answerInstructions: "Use 1-3 sentences.",
			constraints: { minSentences: 1, maxSentences: 3 },
		});
		expect(parsed.questions[1]).toEqual({
			question: "Pick a base",
			type: "single_choice",
			options: [
				{ label: "Rice", value: "rice" },
				{ label: "Salad", value: "Salad", description: "Light" },
			],
			allowOther: true,
			otherLabel: "Custom base",
			answerInstructions: "Choose one only.",
			constraints: { minSelections: 1, maxSelections: 1 },
		});
		expect(parsed.questions[2]).toEqual({
			question: "Pick toppings",
			type: "multiple_choice",
			options: [
				{ label: "Beans", value: "beans" },
				{ label: "Cheese", value: "Cheese" },
			],
			allowOther: true,
			otherLabel: "Other",
			answerInstructions: "Choose up to 2.",
			constraints: { maxSelections: 2 },
		});
		expect(parsed.questions[3]).toEqual({
			question: "Rank lunch priorities",
			type: "ranking",
			options: [
				{ label: "Taste", value: "taste" },
				{ label: "Price", value: "price" },
				{ label: "Speed", value: "speed" },
			],
			allowOther: false,
			otherLabel: "Other",
			answerInstructions: "Rank 1-3.",
			constraints: { minSelections: 3, maxSelections: 3 },
		});
	});
});
