import {
	CustomEditor,
	type AppKeybinding,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type EditorComponent,
} from "@earendil-works/pi-tui";

type Mode = "insert" | "normal";
type Operator = "d" | "c";
type SubmitHandler = (text: string) => void;
type ChangeHandler = (text: string) => void;

type FocusableEditor = EditorComponent & { focused?: boolean };
type AutocompleteAwareEditor = EditorComponent & { isShowingAutocomplete?: () => boolean };

const KEY = {
	left: "\x1b[D",
	down: "\x1b[B",
	up: "\x1b[A",
	right: "\x1b[C",
	wordLeft: "\x1bb",
	wordRight: "\x1bf",
	lineStart: "\x01",
	lineEnd: "\x05",
	deleteForward: "\x1b[3~",
	deleteBackward: "\x7f",
	deleteWordForward: "\x1bd",
	deleteWordBackward: "\x17",
	deleteToLineStart: "\x15",
	deleteToLineEnd: "\x0b",
} as const;

const MOTION_KEYS: Record<string, string> = {
	h: KEY.left,
	j: KEY.down,
	k: KEY.up,
	l: KEY.right,
	b: KEY.wordLeft,
	w: KEY.wordRight,
	"0": KEY.lineStart,
	$: KEY.lineEnd,
};

class VimModalEditor implements EditorComponent {
	readonly actionHandlers = new Map<AppKeybinding, () => void>();
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;

	private mode: Mode = "insert";
	private base: FocusableEditor;
	private keybindings: KeybindingsManager;
	private prefixCount = "";
	private pendingOperator: Operator | undefined;
	private operatorCount = 1;
	private motionCount = "";

	constructor(base: EditorComponent, keybindings: KeybindingsManager) {
		this.base = base;
		this.keybindings = keybindings;
	}

	get focused(): boolean {
		return this.base.focused ?? false;
	}

	set focused(value: boolean) {
		this.base.focused = value;
	}

	get onSubmit(): SubmitHandler | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(handler: SubmitHandler | undefined) {
		this.base.onSubmit = handler;
	}

	get onChange(): ChangeHandler | undefined {
		return this.base.onChange;
	}

	set onChange(handler: ChangeHandler | undefined) {
		this.base.onChange = handler;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.base.borderColor;
	}

	set borderColor(color: ((str: string) => string) | undefined) {
		this.base.borderColor = color;
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
		this.mode = "insert";
		this.clearPendingCommand();
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	handleInput(data: string): void {
		if (this.mode === "insert" && matchesKey(data, "escape")) {
			if (this.isShowingAutocomplete()) {
				this.base.handleInput(data);
				return;
			}
			this.mode = "normal";
			this.clearPendingCommand();
			return;
		}

		if (this.mode === "normal" && matchesKey(data, "escape") && this.hasPendingCommand()) {
			this.clearPendingCommand();
			return;
		}

		if (this.mode === "normal" && this.handleAppKeybinding(data, true)) return;
		if (this.mode === "insert" && this.handleAppKeybinding(data, false)) return;

		if (this.mode === "insert") {
			this.base.handleInput(data);
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.handleNormalKey(data);
			return;
		}

		// Preserve control sequences and app-level behavior from the wrapped editor.
		this.base.handleInput(data);
	}

	render(width: number): string[] {
		const lines = [...this.base.render(width)];
		if (lines.length === 0) return lines;

		const label = this.mode === "normal" ? this.normalModeLabel() : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}

	private handleNormalKey(data: string): void {
		if (data >= "0" && data <= "9") {
			if (data === "0" && !this.hasPendingCommand()) {
				this.repeatInput(KEY.lineStart, this.takePrefixCount());
				return;
			}
			if (this.pendingOperator) this.motionCount += data;
			else this.prefixCount += data;
			return;
		}

		if (this.pendingOperator) {
			this.finishOperator(data);
			return;
		}

		switch (data) {
			case "i":
				this.clearPendingCommand();
				this.mode = "insert";
				return;
			case "a":
				this.clearPendingCommand();
				this.base.handleInput(KEY.right);
				this.mode = "insert";
				return;
			case "I":
				this.clearPendingCommand();
				this.base.handleInput(KEY.lineStart);
				this.mode = "insert";
				return;
			case "A":
				this.clearPendingCommand();
				this.base.handleInput(KEY.lineEnd);
				this.mode = "insert";
				return;
			case "d":
			case "c":
				this.pendingOperator = data;
				this.operatorCount = this.takePrefixCount();
				this.motionCount = "";
				return;
			case "x":
				this.repeatInput(KEY.deleteForward, this.takePrefixCount());
				return;
			case "X":
				this.repeatInput(KEY.deleteBackward, this.takePrefixCount());
				return;
			case "D":
				this.clearPendingCommand();
				this.base.handleInput(KEY.deleteToLineEnd);
				return;
			case "C":
				this.clearPendingCommand();
				this.base.handleInput(KEY.deleteToLineEnd);
				this.mode = "insert";
				return;
			case "S":
				this.operateLines("c", this.takePrefixCount());
				return;
			case "s":
				this.repeatInput(KEY.deleteForward, this.takePrefixCount());
				this.mode = "insert";
				return;
		}

		const seq = MOTION_KEYS[data];
		if (seq) {
			this.repeatInput(seq, this.takePrefixCount());
			return;
		}

		this.clearPendingCommand();
	}

	private finishOperator(motion: string): void {
		const operator = this.pendingOperator!;
		const count = this.operatorCount * this.takeMotionCount();
		this.clearPendingCommand();

		if (motion === operator) {
			this.operateLines(operator, count);
			return;
		}

		switch (motion) {
			case "h":
				this.repeatInput(KEY.deleteBackward, count);
				break;
			case "l":
				this.repeatInput(KEY.deleteForward, count);
				break;
			case "w":
				this.repeatInput(KEY.deleteWordForward, count);
				break;
			case "b":
				this.repeatInput(KEY.deleteWordBackward, count);
				break;
			case "0":
				this.base.handleInput(KEY.deleteToLineStart);
				break;
			case "$":
				this.base.handleInput(KEY.deleteToLineEnd);
				break;
			case "j":
				this.operateLines(operator, count + 1);
				break;
			case "k":
				this.repeatInput(KEY.up, count);
				this.operateLines(operator, count + 1);
				break;
			default:
				return;
		}

		if (operator === "c") this.mode = "insert";
	}

	private operateLines(operator: Operator, count: number): void {
		const lineCount = Math.max(1, count);
		this.base.handleInput(KEY.lineStart);

		if (operator === "c" && lineCount === 1) {
			this.base.handleInput(KEY.deleteToLineEnd);
			this.mode = "insert";
			return;
		}

		for (let i = 0; i < lineCount; i++) {
			this.base.handleInput(KEY.deleteToLineEnd);
			this.base.handleInput(KEY.deleteForward);
		}
		if (operator === "c") this.mode = "insert";
	}

	private repeatInput(seq: string, count: number): void {
		const times = Math.max(1, count);
		for (let i = 0; i < times; i++) this.base.handleInput(seq);
	}

	private takePrefixCount(): number {
		const count = parseCount(this.prefixCount);
		this.prefixCount = "";
		return count;
	}

	private takeMotionCount(): number {
		const count = parseCount(this.motionCount);
		this.motionCount = "";
		return count;
	}

	private hasPendingCommand(): boolean {
		return this.prefixCount.length > 0 || this.pendingOperator !== undefined || this.motionCount.length > 0;
	}

	private clearPendingCommand(): void {
		this.prefixCount = "";
		this.pendingOperator = undefined;
		this.operatorCount = 1;
		this.motionCount = "";
	}

	private normalModeLabel(): string {
		if (this.pendingOperator) return ` NORMAL ${this.pendingOperator}${this.motionCount} `;
		if (this.prefixCount) return ` NORMAL ${this.prefixCount} `;
		return " NORMAL ";
	}

	private handleAppKeybinding(data: string, includeInterrupt: boolean): boolean {
		if (this.onExtensionShortcut?.(data)) return true;

		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}

		if (includeInterrupt && this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return true;
				}
			}
			this.base.handleInput(data);
			return true;
		}

		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return true;
			}
			return false;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action === "app.interrupt" || action === "app.exit") continue;
			if (this.keybindings.matches(data, action)) {
				handler();
				return true;
			}
		}

		return false;
	}

	private isShowingAutocomplete(): boolean {
		return (this.base as AutocompleteAwareEditor).isShowingAutocomplete?.() ?? false;
	}
}

function parseCount(value: string): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export default function vimModalEditorExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new VimModalEditor(base, keybindings);
		});
	});
}
