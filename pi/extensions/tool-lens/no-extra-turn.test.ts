/**
 * Build-gate test (design step 1): flushing a card at idle must not trigger an
 * extra LLM turn.
 *
 * We cannot boot a full Pi agent here, but the load-bearing rule is: cards are
 * only ever appended via `sendMessage` WITHOUT `triggerTurn`, and only when the
 * agent reports idle. This test asserts the flush path obeys both constraints by
 * recording every sendMessage option and a provider-call counter that increments
 * only if a turn would be triggered.
 */
import { describe, expect, it } from "bun:test";
import { flushCards } from "./flush";
import { ToolLensStore } from "./store";

interface SentMessage {
	triggerTurn: boolean;
}

describe("idle flush adds no LLM turn", () => {
	function makeStore(): ToolLensStore {
		const store = new ToolLensStore();
		store.seed({ toolCallId: "a", turnIndex: 1, sourceOrder: 0, toolName: "read", canonicalToolName: "read", startedAt: 0 });
		store.setIntent("a", { intent: "inspect" });
		store.setOutcome("a", { result: "ok", matched: "yes" });
		return store;
	}

	it("never triggers a turn and only sends while idle", () => {
		const store = makeStore();
		const sent: SentMessage[] = [];
		let providerCalls = 0;
		const send = (message: { triggerTurn?: boolean }): void => {
			const triggerTurn = message.triggerTurn === true;
			sent.push({ triggerTurn });
			if (triggerTurn) providerCalls += 1; // a triggered turn would call the provider
		};

		// Not idle: nothing is sent, no provider call.
		flushCards({ store, flushed: new Set(), sink: { send }, isIdle: () => false, persistCards: true });
		expect(sent).toHaveLength(0);

		// Idle: exactly one card, with triggerTurn omitted (=> false).
		const flushedSet = new Set<string>();
		flushCards({ store, flushed: flushedSet, sink: { send }, isIdle: () => true, persistCards: true });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.triggerTurn).toBe(false);
		expect(providerCalls).toBe(0);

		// Second idle flush is a no-op (already flushed), still no provider call.
		flushCards({ store, flushed: flushedSet, sink: { send }, isIdle: () => true, persistCards: true });
		expect(sent).toHaveLength(1);
		expect(providerCalls).toBe(0);
	});
});
