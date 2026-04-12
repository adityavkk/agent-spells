import { describe, expect, it } from "bun:test";
import { buildBamlExtractionContext, parseBamlExtractionResult } from "./extraction";

describe("answer extraction bridge", () => {
	it("renders pi transport context and normalizes parsed baml output for the tui", async () => {
		const context = await buildBamlExtractionContext("Ask one food question.");
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]!.role).toBe("user");
		expect(String(context.messages[0]!.content)).toContain("questionnaire extractor");
		expect(String(context.messages[0]!.content)).toContain("SINGLE_CHOICE");
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
			'      "otherLabel": null',
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
			'      "otherLabel": "Custom base"',
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
			'      "otherLabel": null',
			"    }",
			"  ]",
			"}",
			"```",
		].join("\n"));

		expect(parsed.questions).toHaveLength(3);
		expect(parsed.questions[0]).toEqual({
			question: "What's your ideal spice level?",
			type: "text",
			options: [],
			allowOther: false,
			otherLabel: "Other",
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
		});
	});
});
