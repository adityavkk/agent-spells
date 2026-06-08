import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCurrentThinkingLevel, setCurrentThinkingLevel } from "./model-switcher";

function makePi(opts: {
	sessionLevel?: string;
	effectiveLevel?: string;
	handleSet?: boolean;
} = {}) {
	const setCalls: string[] = [];
	const pi = {
		getThinkingLevel: () => opts.sessionLevel ?? "high",
		setThinkingLevel: (level: string) => setCalls.push(level),
		events: {
			emit(channel: string, data: Record<string, unknown>) {
				if (channel === "model-profiles:get-effective-thinking" && opts.effectiveLevel) {
					data.result = { level: opts.effectiveLevel };
				}
				if (channel === "model-profiles:set-thinking-override" && opts.handleSet) {
					data.handled = true;
				}
			},
		},
	} as unknown as ExtensionAPI;
	return { pi, setCalls };
}

const ctx = {} as ExtensionContext;

describe("leader-key thinking bridge", () => {
	it("prefers effective thinking from model-profiles events", () => {
		const { pi } = makePi({ sessionLevel: "high", effectiveLevel: "low" });
		expect(getCurrentThinkingLevel(pi, ctx)).toBe("low");
	});

	it("falls back to session thinking when no extension handles the event", () => {
		const { pi } = makePi({ sessionLevel: "medium" });
		expect(getCurrentThinkingLevel(pi, ctx)).toBe("medium");
	});

	it("does not write session state when model-profiles handles the override", () => {
		const { pi, setCalls } = makePi({ handleSet: true });
		setCurrentThinkingLevel(pi, ctx, "minimal");
		expect(setCalls).toEqual([]);
	});
});
