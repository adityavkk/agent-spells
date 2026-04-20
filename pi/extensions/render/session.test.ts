import { describe, expect, it } from "bun:test";
import { BlockType, type RenderDoc } from "./baml_client/types";
import { createRenderSession, getCurrentRenderRevision, getRenderSessionSummary, readLatestRenderSession, RENDER_MESSAGE_CUSTOM_TYPE, withCurrentRenderRuntime } from "./session";

function makeDoc(title = "Delivery plan"): RenderDoc {
	return {
		title,
		blocks: [
			{
				id: "overview",
				type: BlockType.MARKDOWN,
				markdown: "Ship it.",
				items: [],
				questions: [],
				collectionItems: [],
			},
		],
	};
}

describe("render session helpers", () => {
	it("creates an initial render session with one revision", () => {
		const session = createRenderSession({
			doc: makeDoc(),
			sourceEntryId: "assistant-1",
			sourceSessionFile: "/tmp/session.jsonl",
			reason: "extract",
			surface: "tui",
		});

		expect(session.id.startsWith("render-")).toBeTrue();
		expect(session.currentRevisionId).toContain(":r1");
		expect(session.revisions).toHaveLength(1);
		expect(session.source).toEqual({
			entryId: "assistant-1",
			role: "assistant",
			sessionFile: "/tmp/session.jsonl",
		});

		const revision = getCurrentRenderRevision(session);
		expect(revision.kind).toBe("initial");
		expect(revision.runtime).toEqual(expect.objectContaining({
			renderSessionId: session.id,
			sourceEntryId: "assistant-1",
			revision: 1,
			branch: {
				mode: "tree-revision",
				sessionFile: "/tmp/session.jsonl",
				leafEntryId: "assistant-1",
			},
		}));
	});

	it("updates the current revision runtime without changing session shape", () => {
		const session = createRenderSession({
			doc: makeDoc(),
			sourceEntryId: "assistant-1",
		});
		const updated = withCurrentRenderRuntime(session, {
			...getCurrentRenderRevision(session).runtime,
			selections: { activeBlockId: "overview" },
		});

		expect(getCurrentRenderRevision(updated).runtime.selections).toEqual({ activeBlockId: "overview" });
		expect(updated.currentRevisionId).toBe(session.currentRevisionId);
		expect(updated.revisions).toHaveLength(1);
	});

	it("reads the latest persisted render session from branch messages", () => {
		const older = createRenderSession({ doc: makeDoc("Older"), sourceEntryId: "assistant-1" });
		const newer = createRenderSession({ doc: makeDoc("Newer"), sourceEntryId: "assistant-2" });
		const branch = [
			{
				type: "message",
				message: {
					role: "custom",
					customType: RENDER_MESSAGE_CUSTOM_TYPE,
					details: { session: older },
				},
			},
			{
				type: "message",
				message: {
					role: "custom",
					customType: "something-else",
					details: {},
				},
			},
			{
				type: "message",
				message: {
					role: "custom",
					customType: RENDER_MESSAGE_CUSTOM_TYPE,
					details: { session: newer },
				},
			},
		];

		expect(readLatestRenderSession(branch)).toEqual(newer);
		expect(getRenderSessionSummary(newer)).toBe("Newer (1 block)");
	});
});
