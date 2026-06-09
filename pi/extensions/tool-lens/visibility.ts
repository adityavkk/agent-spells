/**
 * Global visibility state for tool-lens, shared by the HUD and the cards.
 *
 * Three states (`full | compact | hidden`) cycle through a configurable order.
 * The state lives only in memory for the session; it never mutates the session
 * file. A subscriber callback lets the extension force a repaint when the state
 * changes (via setStatus).
 */
import type { ToolLensVisibility } from "./types";

export class VisibilityState {
	private current: ToolLensVisibility;
	private readonly cycle: ToolLensVisibility[];
	private readonly listeners = new Set<(value: ToolLensVisibility) => void>();

	constructor(initial: ToolLensVisibility, cycle: ToolLensVisibility[]) {
		this.cycle = cycle.length > 0 ? cycle : ["full", "compact", "hidden"];
		this.current = this.cycle.includes(initial) ? initial : this.cycle[0]!;
	}

	get value(): ToolLensVisibility {
		return this.current;
	}

	set(value: ToolLensVisibility): void {
		if (value === this.current) return;
		this.current = value;
		this.emit();
	}

	/** Advance to the next state in the configured cycle. */
	toggle(): ToolLensVisibility {
		const index = this.cycle.indexOf(this.current);
		this.current = this.cycle[(index + 1) % this.cycle.length]!;
		this.emit();
		return this.current;
	}

	/** Parse a `/tool-lens` argument into an action. Returns null if invalid. */
	apply(arg: string): ToolLensVisibility | null {
		const text = arg.trim().toLowerCase();
		if (text === "toggle") return this.toggle();
		if (text === "full" || text === "compact" || text === "hidden") {
			this.set(text);
			return this.current;
		}
		return null;
	}

	subscribe(listener: (value: ToolLensVisibility) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener(this.current);
	}
}
