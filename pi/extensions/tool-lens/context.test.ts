import { describe, expect, it } from "bun:test";
import { DEFAULT_TOOL_LENS_CONFIG } from "./config";
import { buildConversationContext, type ConversationMessageLike } from "./context";

const config = DEFAULT_TOOL_LENS_CONFIG;

describe("buildConversationContext", () => {
	it("formats recent messages oldest-first and labels roles", () => {
		const messages: ConversationMessageLike[] = [
			{ role: "user", content: "read the readme" },
			{ role: "assistant", content: [{ type: "text", text: "on it" }] },
		];
		const built = buildConversationContext(messages, config);
		expect(built.messageCount).toBe(2);
		expect(built.text).toBe("user: read the readme\n\nassistant: on it");
	});

	it("limits to the last N messages", () => {
		const messages: ConversationMessageLike[] = Array.from({ length: 12 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const built = buildConversationContext(messages, { ...config, context: { ...config.context, maxMessages: 3 } });
		expect(built.messageCount).toBe(3);
		expect(built.text).toContain("m11");
		expect(built.text).not.toContain("m8");
	});

	it("excludes tool-lens custom cards and respects includePriorToolResults", () => {
		const messages: ConversationMessageLike[] = [
			{ role: "custom", customType: "tool-lens", content: "secret analysis" },
			{ role: "toolResult", content: [{ type: "text", text: "ran tests" }] },
			{ role: "user", content: "ok" },
		];
		const withTools = buildConversationContext(messages, config);
		expect(withTools.text).not.toContain("secret analysis");
		expect(withTools.text).toContain("tool: ran tests");

		const withoutTools = buildConversationContext(messages, {
			...config,
			context: { ...config.context, includePriorToolResults: false },
		});
		expect(withoutTools.text).not.toContain("ran tests");
	});

	it("redacts secrets and truncates to the char budget", () => {
		const messages: ConversationMessageLike[] = [{ role: "user", content: "API_KEY=sk-supersecret012345 " + "x".repeat(50) }];
		const built = buildConversationContext(messages, { ...config, context: { ...config.context, maxChars: 20 } });
		expect(built.truncated).toBe(true);
		expect(built.text.startsWith("…")).toBe(true);
		expect(built.text).not.toContain("supersecret");
	});
});
