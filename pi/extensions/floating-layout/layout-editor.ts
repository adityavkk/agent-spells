/**
 * LayoutEditor: a CustomEditor that consumes the entire visible viewport.
 *
 * Slot: pi places the editor at the bottom of its component stack. When this
 * editor's render() returns `terminalHeight` lines, the live viewport is
 * entirely owned by this component. Pi's built-in chat container is still
 * rendered above but gets pushed into terminal scrollback; the user sees
 * only what LayoutEditor draws.
 *
 * Composition per frame:
 *   ┌─ sidebar (fixed width, hidden on narrow terms)
 *   │  ┌─ chat viewport (flex; scrolled slice of ChatBuffer lines)
 *   │  │  ┌─ scrollbar column (1 col, right edge of chat)
 *   │  │  └─ composer (pi-tui Editor output; bottom N rows)
 *
 * Input routing:
 *   - PgUp/PgDn/mouseWheel-like keys adjust scrollTop (stickToBottom = false)
 *   - everything else forwards to the internal Editor (typing, submit,
 *     autocomplete, paste, etc.)
 */
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ChatBuffer } from "./chat-buffer.js";
import { renderScrollbarColumn } from "./scrollbar.js";
import { renderSidebar } from "./sidebar.js";
import { padPlain, stripAnsi } from "./util.js";

const SIDEBAR_WIDTH = 24;
const SIDEBAR_MIN_TERM_WIDTH = 100;
const MIN_CHAT_HEIGHT = 3;
const SCROLL_LINE_STEP = 3;
const SCROLL_PAGE_STEP = 10;
const SCROLL_BIGPAGE_STEP = 30;

// Mouse SGR wheel sequence: `\x1b[<B;X;Y(M|m)` with B=64 (up) / B=65 (down).
// Modifiers OR into B: shift=+4, alt=+8, ctrl=+16 (see xterm mouse SGR spec).
const MOUSE_WHEEL_RE = /\x1b\[<(6[45])(?:;\d+){2}[Mm]/g;

export interface LayoutEditorConfig {
  chatBuffer: ChatBuffer;
  getLabel: () => string;
  getSessionLabel?: () => string | undefined;
  getModelLabel?: () => string | undefined;
}

export class LayoutEditor extends CustomEditor {
  private chatBuffer!: ChatBuffer;
  private config!: LayoutEditorConfig;
  private scrollTop = 0;
  private stickToBottom = true;
  private lastSeenVersion = -1;
  private lastChatWidth = 0;

  configure(config: LayoutEditorConfig): void {
    this.chatBuffer = config.chatBuffer;
    this.config = config;
  }

  private get termHeight(): number {
    // `tui` is protected on Editor; we reach in for terminal rows.
    return (this as any).tui?.terminal?.rows ?? 24;
  }

  private get termWidth(): number {
    return (this as any).tui?.terminal?.columns ?? 80;
  }

  private getTheme(): any {
    // CustomEditor stores theme; if absent we degrade to no-op styling.
    const t = (this as any).theme;
    return t && typeof t.fg === "function" ? t : null;
  }

  override render(width: number): string[] {
    if (!this.chatBuffer) return super.render(width);

    const height = this.termHeight;
    const theme = this.getTheme();

    // Render composer first so we know how many rows to reserve at the bottom.
    const composerLines = super.render(width);
    const composerH = composerLines.length;

    const chatHeight = Math.max(MIN_CHAT_HEIGHT, height - composerH);

    const sidebarVisible = width >= SIDEBAR_MIN_TERM_WIDTH;
    const sidebarW = sidebarVisible ? SIDEBAR_WIDTH : 0;
    const scrollbarW = 1;
    const chatPaneW = Math.max(1, width - sidebarW - scrollbarW);

    // Chat buffer → flattened lines, wrapped to chatPaneW.
    // Invalidate cache when width changes.
    if (chatPaneW !== this.lastChatWidth) this.lastChatWidth = chatPaneW;
    const chatLines = this.chatBuffer.getLines(chatPaneW);
    const total = chatLines.length;

    // Sticky-scroll: if we're pinned to bottom (or buffer grew while pinned),
    // track the tail automatically on every render.
    if (this.stickToBottom || this.lastSeenVersion !== this.chatBuffer.version) {
      if (this.stickToBottom) this.scrollTop = Math.max(0, total - chatHeight);
      this.lastSeenVersion = this.chatBuffer.version;
    }
    // Clamp scroll after any buffer changes.
    const maxScroll = Math.max(0, total - chatHeight);
    if (this.scrollTop > maxScroll) this.scrollTop = maxScroll;
    if (this.scrollTop < 0) this.scrollTop = 0;

    const visibleChat = chatLines.slice(this.scrollTop, this.scrollTop + chatHeight);
    while (visibleChat.length < chatHeight) visibleChat.push("");

    // Debug line so we can see scroll state change in the sidebar while
    // iterating. Remove once we trust the scrollbar math.
    const pct = total <= chatHeight ? 100 : Math.round((this.scrollTop / Math.max(1, total - chatHeight)) * 100);
    const dbg = `${this.scrollTop}/${total} ${pct}%${this.stickToBottom ? " stick" : ""}`;

    const sidebarLines = sidebarVisible
      ? renderSidebar({
          width: sidebarW,
          height: chatHeight,
          theme,
          label: this.config.getLabel(),
          sessionLabel: this.config.getSessionLabel?.(),
          modelLabel: this.config.getModelLabel?.(),
          hints: [
            "wheel / shift+↑↓ line",
            "alt+↑↓ page",
            "shift+home/end jump",
            `dbg ${dbg}`,
          ],
        })
      : [];

    const scrollbar = renderScrollbarColumn({
      height: chatHeight,
      scrollTop: this.scrollTop,
      viewSize: chatHeight,
      total,
      theme,
    });

    // Compose each row top-down.
    const out: string[] = [];
    for (let row = 0; row < chatHeight; row++) {
      const chatCell = padPlain(visibleChat[row] ?? "", chatPaneW);
      const scrollCell = scrollbar[row] ?? "│";
      let line: string;
      if (sidebarVisible) {
        const sidebarCell = padPlain(sidebarLines[row] ?? "", sidebarW);
        line = sidebarCell + chatCell + scrollCell;
      } else {
        line = chatCell + scrollCell;
      }
      out.push(truncateToWidth(line, width));
    }
    // Composer rows (already width-sized by pi-tui).
    for (const line of composerLines) out.push(truncateToWidth(line, width));

    return out;
  }

  override handleInput(data: string): void {
    // Mouse wheel (SGR) — captured when mouse mode is enabled by the
    // extension. Each wheel tick fires once. Process first; wheel sequences
    // must not leak into the composer as printable text.
    if (data.includes("\x1b[<")) {
      let consumed = false;
      const matches = data.matchAll(MOUSE_WHEEL_RE);
      for (const m of matches) {
        consumed = true;
        if (m[1] === "64") this.scrollBy(-SCROLL_LINE_STEP);
        else this.scrollBy(SCROLL_LINE_STEP);
      }
      if (consumed) {
        // Strip any mouse sequences out before forwarding remainder to editor.
        const remainder = data.replace(MOUSE_WHEEL_RE, "").replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
        if (remainder.length > 0) super.handleInput(remainder);
        return;
      }
    }

    // Keyboard scroll keys. Chosen to avoid pi-tui editor bindings:
    //   editor uses bare Up/Down/Home/End/PageUp/PageDown for cursor / paging.
    //   we use the Shift- and Alt- modified variants for viewport scroll.
    if (matchesKey(data, Key.shift("up"))) {
      this.scrollBy(-SCROLL_LINE_STEP);
      return;
    }
    if (matchesKey(data, Key.shift("down"))) {
      this.scrollBy(SCROLL_LINE_STEP);
      return;
    }
    if (matchesKey(data, Key.alt("up"))) {
      this.scrollBy(-SCROLL_PAGE_STEP);
      return;
    }
    if (matchesKey(data, Key.alt("down"))) {
      this.scrollBy(SCROLL_PAGE_STEP);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-SCROLL_PAGE_STEP);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(SCROLL_PAGE_STEP);
      return;
    }
    if (matchesKey(data, Key.shift("pageUp"))) {
      this.scrollBy(-SCROLL_BIGPAGE_STEP);
      return;
    }
    if (matchesKey(data, Key.shift("pageDown"))) {
      this.scrollBy(SCROLL_BIGPAGE_STEP);
      return;
    }
    if (matchesKey(data, Key.shift("home")) || matchesKey(data, Key.ctrl("home"))) {
      this.scrollTop = 0;
      this.stickToBottom = false;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("end")) || matchesKey(data, Key.ctrl("end"))) {
      this.stickToBottom = true;
      this.invalidate();
      return;
    }
    super.handleInput(data);
  }

  private scrollBy(delta: number): void {
    this.scrollTop = Math.max(0, this.scrollTop + delta);
    // Any upward scroll un-sticks; downward scroll only re-sticks when the
    // next render clamps us back to the tail (handled in render()).
    if (delta < 0) this.stickToBottom = false;
    this.invalidate();
  }

  stickBottom(): void {
    this.stickToBottom = true;
    this.scrollTop = Number.MAX_SAFE_INTEGER;
    this.invalidate();
  }

  // Hint for debugging / status widgets.
  getScrollState(): { scrollTop: number; stickToBottom: number } {
    return { scrollTop: this.scrollTop, stickToBottom: this.stickToBottom ? 1 : 0 };
  }
}

/** Silence unused import warnings for helpers we only use conditionally above. */
void stripAnsi;
void visibleWidth;
