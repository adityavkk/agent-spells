import { describe, expect, it } from "bun:test";
import { VisibilityState } from "./visibility";

describe("VisibilityState", () => {
	it("cycles through the configured order", () => {
		const state = new VisibilityState("full", ["full", "compact", "hidden"]);
		expect(state.value).toBe("full");
		expect(state.toggle()).toBe("compact");
		expect(state.toggle()).toBe("hidden");
		expect(state.toggle()).toBe("full");
	});

	it("falls back to the first cycle value for an invalid initial state", () => {
		const state = new VisibilityState("hidden", ["full", "compact"]);
		expect(state.value).toBe("full");
	});

	it("applies explicit /tool-lens arguments and toggle", () => {
		const state = new VisibilityState("full", ["full", "compact", "hidden"]);
		expect(state.apply("hidden")).toBe("hidden");
		expect(state.apply("FULL")).toBe("full");
		expect(state.apply("toggle")).toBe("compact");
		expect(state.apply("bogus")).toBeNull();
	});

	it("notifies subscribers only on change", () => {
		const state = new VisibilityState("full", ["full", "compact", "hidden"]);
		const seen: string[] = [];
		const unsubscribe = state.subscribe((value) => seen.push(value));
		state.set("full"); // no change
		state.set("compact");
		state.toggle();
		unsubscribe();
		state.toggle();
		expect(seen).toEqual(["compact", "hidden"]);
	});
});
