import { describe, expect, it } from "bun:test";
import { CODEX_PLAN_CUSTOM_TYPE, createCodexPlanState, latestPlanFromEntries } from "./plan-state";

describe("Codex plan state", () => {
	it("loads the latest valid persisted plan from session entries", () => {
		const first = { version: 1, plan: [{ step: "old", status: "completed" }], updatedAt: "2024-01-01T00:00:00.000Z" };
		const second = { version: 1, plan: [{ step: "new", status: "in_progress" }], explanation: "now", updatedAt: "2024-01-02T00:00:00.000Z" };

		const latest = latestPlanFromEntries([
			{ type: "custom", customType: "other", data: first },
			{ type: "custom", customType: CODEX_PLAN_CUSTOM_TYPE, data: first },
			{ type: "custom", customType: CODEX_PLAN_CUSTOM_TYPE, data: { version: 1, plan: [{ step: "bad", status: "invalid" }] } },
			{ type: "custom", customType: CODEX_PLAN_CUSTOM_TYPE, data: second },
		]);

		expect(latest).toEqual(second);
	});

	it("persists plan updates through Pi custom entries", () => {
		const entries: Array<{ customType: string; data: unknown }> = [];
		const state = createCodexPlanState({ appendEntry(customType, data) { entries.push({ customType, data }); } });

		const result = state.update([{ step: "Implement", status: "in_progress" }], "Working");

		expect(result.content[0]?.text).toBe("Working\n\n- [in_progress] Implement");
		expect(result.details).toMatchObject({ persisted: true, customType: CODEX_PLAN_CUSTOM_TYPE, plan: [{ step: "Implement", status: "in_progress" }] });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.customType).toBe(CODEX_PLAN_CUSTOM_TYPE);
		expect(entries[0]?.data).toMatchObject({ version: 1, explanation: "Working", plan: [{ step: "Implement", status: "in_progress" }] });
	});

	it("reconstructs in-memory state from a session branch", () => {
		const state = createCodexPlanState({ appendEntry() {} });
		state.loadFromSession({ sessionManager: { getBranch() { return [{ type: "custom", customType: CODEX_PLAN_CUSTOM_TYPE, data: { version: 1, plan: [{ step: "Persisted", status: "pending" }], updatedAt: "2024-01-01T00:00:00.000Z" } }]; } } });

		expect(state.current()).toEqual([{ step: "Persisted", status: "pending" }]);
	});
});
