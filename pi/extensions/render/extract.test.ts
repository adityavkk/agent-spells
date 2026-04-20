import { describe, expect, it } from "bun:test";
import { BlockType, EmbeddedContentType, PreferredView, QuestionType } from "./baml_client/types";
import { buildBamlRenderContext, parseBamlRenderResult } from "./extract";

describe("render extraction bridge", () => {
	it("renders pi transport context and normalizes parsed baml output", async () => {
		const context = await buildBamlRenderContext("Summarize this feature as overview, steps, and questions.");

		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]!.role).toBe("user");
		expect(String(context.messages[0]!.content)).toContain("structured renderer extractor");
		expect(String(context.messages[0]!.content)).toContain("COLLECTION");
		expect(String(context.messages[0]!.content)).toContain("QUESTIONNAIRE");
		expect(String(context.messages[0]!.content)).toContain("Summarize this feature as overview, steps, and questions.");

		const parsed = parseBamlRenderResult([
			"```json",
			"{",
			'  "title": "  Delivery plan  ",',
			'  "introMarkdown": " N/A ",',
			'  "blocks": [',
			"    {",
			'      "id": "overview",',
			'      "type": "MARKDOWN",',
			'      "title": null,',
			'      "preferredView": null,',
			'      "ordered": null,',
			'      "markdown": "# Overview\\n\\nShip the feature.",',
			'      "items": [],',
			'      "questions": [],',
			'      "collectionItems": []',
			"    },",
			"    {",
			'      "id": null,',
			'      "type": "LIST",',
			'      "title": "Steps",',
			'      "preferredView": "TABS",',
			'      "ordered": true,',
			'      "markdown": null,',
			'      "items": [',
			'        { "id": "same", "navLabel": "This label is far too long for a terminal tab row", "title": null, "summary": null, "bodyMarkdown": "First" },',
			'        { "id": "same", "navLabel": null, "title": "Second", "summary": null, "bodyMarkdown": "Second body" }',
			'      ],',
			'      "questions": [],',
			'      "collectionItems": []',
			"    },",
			"    {",
			'      "id": null,',
			'      "type": "QUESTIONNAIRE",',
			'      "title": "Questions",',
			'      "preferredView": null,',
			'      "ordered": null,',
			'      "markdown": null,',
			'      "items": [],',
			'      "questions": [',
			'        {',
			'          "id": null,',
			'          "type": "MULTIPLE_CHOICE",',
			'          "question": "Pick owners",',
			'          "context": "N/A",',
			'          "options": [',
			'            { "id": null, "label": "API", "value": null, "description": null },',
			'            { "id": null, "label": "UI", "value": "ui", "description": "Frontend" }',
			'          ],',
			'          "allowOther": true,',
			'          "otherLabel": null,',
			'          "answerInstructions": "Choose 1-2.",',
			'          "constraints": { "minSelections": 2, "maxSelections": 1, "minSentences": null, "maxSentences": null }',
			'        }',
			'      ],',
			'      "collectionItems": []',
			"    },",
			"    {",
			'      "id": null,',
			'      "type": "COLLECTION",',
			'      "title": "Views",',
			'      "preferredView": "TABS",',
			'      "ordered": null,',
			'      "markdown": null,',
			'      "items": [],',
			'      "questions": [],',
			'      "collectionItems": [',
			'        {',
			'          "id": null,',
			'          "navLabel": "Overview",',
			'          "title": "Overview",',
			'          "summary": null,',
			'          "content": {',
			'            "type": "MARKDOWN",',
			'            "markdown": "Hello",',
			'            "ordered": null,',
			'            "items": [],',
			'            "questions": []',
			'          }',
			'        }',
			'      ]',
			"    }",
			"  ]",
			"}",
			"```",
		].join("\n"));

		expect(parsed.title).toBe("Delivery plan");
		expect(parsed.introMarkdown).toBeUndefined();
		expect(parsed.blocks).toHaveLength(4);

		expect(parsed.blocks[0]).toEqual({
			id: "overview",
			type: BlockType.MARKDOWN,
			markdown: "# Overview\n\nShip the feature.",
			items: [],
			questions: [],
			collectionItems: [],
		});

		expect(parsed.blocks[1]).toEqual(expect.objectContaining({
			type: BlockType.LIST,
			title: "Steps",
			preferredView: PreferredView.TABS,
			ordered: true,
		}));
		expect(parsed.blocks[1]?.items).toEqual([
			expect.objectContaining({ id: "same", navLabel: "This label is far…", bodyMarkdown: "First" }),
			expect.objectContaining({ id: "same-2", navLabel: "Second", title: "Second", bodyMarkdown: "Second body" }),
		]);

		expect(parsed.blocks[2]).toEqual(expect.objectContaining({
			type: BlockType.QUESTIONNAIRE,
			title: "Questions",
		}));
		expect(parsed.blocks[2]?.questions[0]).toEqual(expect.objectContaining({
			type: QuestionType.MULTIPLE_CHOICE,
			allowOther: true,
			otherLabel: "Other",
			answerInstructions: "Choose 1-2.",
			constraints: { minSelections: 2, maxSelections: 2 },
		}));
		expect(parsed.blocks[2]?.questions[0]?.options).toEqual([
			expect.objectContaining({ label: "API", value: "API" }),
			expect.objectContaining({ label: "UI", value: "ui", description: "Frontend" }),
		]);

		expect(parsed.blocks[3]).toEqual(expect.objectContaining({
			type: BlockType.COLLECTION,
			title: "Views",
			preferredView: PreferredView.STACK,
		}));
		expect(parsed.blocks[3]?.collectionItems[0]?.content).toEqual({
			type: EmbeddedContentType.MARKDOWN,
			markdown: "Hello",
			items: [],
			questions: [],
		});
	}, { timeout: 20_000 });
});
