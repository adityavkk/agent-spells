import { describe, expect, it } from "bun:test";
import { BlockType, EmbeddedContentType, PreferredView, QuestionType } from "./baml_client/types";
import {
	createInitialRenderRuntime,
	normalizeRenderBranchRef,
	normalizeRenderDoc,
	normalizeRenderRuntime,
} from "./normalize";

describe("normalizeRenderDoc", () => {
	it("falls back to markdown when extraction is empty", () => {
		const doc = normalizeRenderDoc({}, { fallbackMarkdown: "Fallback body" });

		expect(doc).toEqual({
			blocks: [
				{
					id: "fallback-markdown",
					type: BlockType.MARKDOWN,
					markdown: "Fallback body",
					items: [],
					questions: [],
					collectionItems: [],
				},
			],
		});
	});

	it("infers top-level list blocks and downgrades unsafe tabs", () => {
		const doc = normalizeRenderDoc({
			title: "  Delivery plan  ",
			type: "list",
			preferredView: "tabs",
			items: [
				{ title: "One", bodyMarkdown: "First" },
				{ title: "Two", bodyMarkdown: "Second" },
				{ title: "Three", bodyMarkdown: "Third" },
				{ title: "Four", bodyMarkdown: "Fourth" },
				{ title: "Five", bodyMarkdown: "Fifth" },
				{ title: "Six", bodyMarkdown: "Sixth" },
				{ title: "Seven", bodyMarkdown: "Seventh" },
				{ title: "Eight", bodyMarkdown: "Eighth" },
			],
		});

		expect(doc.title).toBe("Delivery plan");
		expect(doc.blocks).toHaveLength(1);
		expect(doc.blocks[0]).toEqual(expect.objectContaining({
			type: BlockType.LIST,
			preferredView: PreferredView.STACK,
		}));
		expect(doc.blocks[0]?.type === BlockType.LIST && doc.blocks[0].items).toHaveLength(8);
	});

	it("normalizes list items, truncates nav labels, and dedupes ids", () => {
		const doc = normalizeRenderDoc({
			blocks: [
				{
					type: "list",
					items: [
						{
							id: "same",
							navLabel: "This label is far too long for a terminal tab row",
							bodyMarkdown: "Alpha",
						},
						{
							id: "same",
							title: "Beta",
							bodyMarkdown: "Beta",
						},
					],
				},
			],
		});

		const block = doc.blocks[0];
		expect(block?.type).toBe(BlockType.LIST);
		if (!block || block.type !== BlockType.LIST) throw new Error("expected list block");

		expect(block.items[0]).toEqual(expect.objectContaining({
			id: "same",
			navLabel: "This label is far…",
			bodyMarkdown: "Alpha",
		}));
		expect(block.items[1]?.id).toBe("same-2");
	});

	it("normalizes questionnaire questions and repairs constraints", () => {
		const doc = normalizeRenderDoc({
			blocks: [
				{
					type: "questionnaire",
					questions: [
						{
							question: "Pick toppings",
							type: "multiple choice",
							allowOther: true,
							otherLabel: "  ",
							constraints: { minSelections: 3, maxSelections: 1 },
							options: ["Cheese", "Olives", "  "],
						},
						{
							question: "Explain why",
							type: "ranking",
							constraints: { minSentences: 4, maxSentences: 2 },
						},
					],
				},
			],
		});

		const block = doc.blocks[0];
		expect(block?.type).toBe(BlockType.QUESTIONNAIRE);
		if (!block || block.type !== BlockType.QUESTIONNAIRE) throw new Error("expected questionnaire block");

		expect(block.questions[0]).toEqual(expect.objectContaining({
			type: QuestionType.MULTIPLE_CHOICE,
			allowOther: true,
			otherLabel: "Other",
			constraints: { minSelections: 3, maxSelections: 3 },
		}));
		expect(block.questions[0]?.type === QuestionType.MULTIPLE_CHOICE && block.questions[0].options.map((option) => option.label)).toEqual([
			"Cheese",
			"Olives",
		]);
		expect(block.questions[1]).toEqual(expect.objectContaining({
			type: QuestionType.TEXT,
			constraints: { minSentences: 4, maxSentences: 4 },
		}));
	});

	it("normalizes collection items with inferred embedded content", () => {
		const doc = normalizeRenderDoc({
			blocks: [
				{
					type: "collection",
					preferredView: "tabs",
					items: [
						{
							title: "Overview",
							markdown: "# Summary\n\nhello",
						},
						{
							title: "Questions",
							questions: [
								{ question: "Ship it?", options: ["Yes", "No"] },
							],
						},
					],
				},
			],
		});

		const block = doc.blocks[0];
		expect(block?.type).toBe(BlockType.COLLECTION);
		if (!block || block.type !== BlockType.COLLECTION) throw new Error("expected collection block");

		expect(block.preferredView).toBe(PreferredView.TABS);
		expect(block.collectionItems[0]?.content).toEqual({
			type: EmbeddedContentType.MARKDOWN,
			markdown: "# Summary\n\nhello",
			items: [],
			questions: [],
		});
		expect(block.collectionItems[1]?.content).toEqual(expect.objectContaining({ type: EmbeddedContentType.QUESTIONNAIRE }));
	});
});

describe("render runtime normalization", () => {
	it("creates initial runtime defaults", () => {
		expect(createInitialRenderRuntime({
			renderSessionId: "render-1",
			sourceEntryId: "entry-1",
		})).toEqual({
			renderSessionId: "render-1",
			sourceEntryId: "entry-1",
			revision: 1,
			selections: {},
			answers: {},
			edits: {},
			branch: { mode: "none" },
		});
	});

	it("normalizes runtime payloads and branch refs", () => {
		const runtime = normalizeRenderRuntime({
			renderSessionId: "  keep-me  ",
			sourceEntryId: "src-2",
			revision: 3.8,
			selections: { block: "a" },
			answers: { q1: "yes" },
			edits: ["bad"],
			branch: {
				mode: "tree-revision",
				sessionFile: "  /tmp/session.jsonl  ",
				leafEntryId: " leaf-9 ",
			},
		}, {
			renderSessionId: "fallback-render",
			sourceEntryId: "fallback-entry",
		});

		expect(runtime).toEqual({
			renderSessionId: "keep-me",
			sourceEntryId: "src-2",
			revision: 3,
			selections: { block: "a" },
			answers: { q1: "yes" },
			edits: {},
			branch: {
				mode: "tree-revision",
				sessionFile: "/tmp/session.jsonl",
				leafEntryId: "leaf-9",
			},
		});
	});

	it("normalizes invalid branch refs to none", () => {
		expect(normalizeRenderBranchRef({ mode: "weird", sessionFile: "x" })).toEqual({
			mode: "none",
			sessionFile: "x",
		});
	});
});
