/**
 * floating-layout
 *
 * Opencode-style full-viewport layout for pi as a pure extension.
 *
 * Owns:
 *   - fixed sidebar (left column; hidden below 100 cols)
 *   - scrollable chat viewport (flex middle; PgUp/PgDn, sticky-scroll-to-bottom)
 *   - fixed composer (pi-tui editor at the bottom)
 *
 * Achieves this by registering a custom editor component via
 * `ctx.ui.setEditorComponent()` that renders `terminalHeight` lines. Pi's
 * built-in chat container renders above as usual and gets pushed into
 * terminal scrollback — the user never sees it in the live viewport because
 * our editor covers the entire visible area.
 *
 * MVP status:
 *   - plain-text message rendering via ChatBuffer (good enough to iterate)
 *   - toggle on/off via /layout command
 *   - on by default if extension is loaded; disable `floating-composer` in
 *     home-manager to avoid composer/setEditorComponent fights.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ChatBuffer } from "./chat-buffer.js";
import { LayoutEditor } from "./layout-editor.js";

const STATUS_KEY = "floating-layout";
const DEFAULT_LABEL = "pi";

export default function floatingLayoutExtension(pi: ExtensionAPI) {
  const buffer = new ChatBuffer();
  let editorRef: LayoutEditor | null = null;
  let active = false;
  let ctxRef: ExtensionContext | null = null;

  const requestRender = () => {
    ctxRef?.ui && (ctxRef.ui as any).tui?.requestRender?.();
  };

  const getLabel = () => DEFAULT_LABEL;
  const getSessionLabel = () => {
    try {
      const entries = ctxRef?.sessionManager?.getEntries?.() ?? [];
      const count = entries.length;
      return count > 0 ? `${count} entries` : "fresh";
    } catch {
      return undefined;
    }
  };
  const getModelLabel = () => {
    const m = ctxRef?.model;
    if (!m) return undefined;
    return `${m.provider}/${m.id}`;
  };

  function activate(ctx: ExtensionContext): void {
    if (active) return;
    ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) => {
      const editor = new LayoutEditor(tui, theme, kb);
      editor.configure({
        chatBuffer: buffer,
        getLabel,
        getSessionLabel,
        getModelLabel,
      });
      editorRef = editor;
      return editor;
    });
    active = true;
    ctx.ui.setStatus(STATUS_KEY, theme_fg(ctx, "accent", "layout:on"));
    ctx.ui.notify("Layout mode enabled", "info");
    requestRender();
  }

  function deactivate(ctx: ExtensionContext): void {
    if (!active) return;
    ctx.ui.setEditorComponent(undefined as any);
    active = false;
    editorRef = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.notify("Layout mode disabled (pi default editor restored)", "info");
    requestRender();
  }

  function toggle(ctx: ExtensionContext): void {
    if (active) deactivate(ctx);
    else activate(ctx);
  }

  pi.registerCommand("layout", {
    description: "Toggle opencode-style full-viewport layout",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "on", label: "on" },
        { value: "off", label: "off" },
        { value: "toggle", label: "toggle (default)" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const verb = (args || "").trim().toLowerCase();
      if (verb === "on") activate(ctx);
      else if (verb === "off") deactivate(ctx);
      else toggle(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    // Do NOT auto-activate. User triggers via `/layout on`.
    // Reset buffer on fresh sessions; backfill from existing entries.
    buffer.clear();
    backfillFromEntries(ctx, buffer);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (active) ctx.ui.setEditorComponent(undefined as any);
    active = false;
    editorRef = null;
    ctxRef = null;
  });

  // Insertion strategy:
  //   user:       once on message_start (dedupe on message_end)
  //   assistant:  create on message_start, mutate on message_update,
  //               finalize on message_end
  //   toolResult: once on message_end (so we have final content)
  pi.on("message_start", async (event) => {
    const msg = event.message;
    if (msg.role === "user") buffer.onUserMessage(msg);
    else if (msg.role === "assistant") buffer.onAssistantStart(msg);
    requestRender();
  });

  pi.on("message_update", async (event) => {
    if (event.message.role === "assistant") {
      buffer.onAssistantUpdate(event.message);
      requestRender();
    }
  });

  pi.on("message_end", async (event) => {
    const msg = event.message;
    if (msg.role === "assistant") buffer.onAssistantEnd(msg);
    else if (msg.role === "toolResult") buffer.onToolResult(msg);
    else if (msg.role === "user") buffer.onUserMessage(msg); // no-op if dup
    requestRender();
  });

  pi.on("tool_execution_start", async (event) => {
    buffer.onToolStart(event.toolCallId, event.toolName, event.args);
    requestRender();
  });

  pi.on("tool_execution_end", async (event) => {
    buffer.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
    requestRender();
  });
}

function theme_fg(ctx: ExtensionContext, token: string, text: string): string {
  const t = (ctx.ui as any).theme;
  if (t && typeof t.fg === "function") return t.fg(token, text);
  return text;
}

/**
 * Backfill the chat buffer from existing session entries (resume / fork case).
 * We only replay user/assistant/toolResult message entries; thinking & other
 * metadata are ignored in MVP.
 */
function backfillFromEntries(ctx: ExtensionContext, buffer: ChatBuffer): void {
  try {
    const entries: any[] = ctx.sessionManager?.getEntries?.() ?? [];
    for (const entry of entries) {
      if (entry?.type !== "message" || !entry?.message) continue;
      const msg = entry.message;
      if (msg.role === "user") buffer.onUserMessage(msg);
      else if (msg.role === "assistant") buffer.onAssistantEnd(msg);
      else if (msg.role === "toolResult") buffer.onToolResult(msg);
    }
  } catch {
    /* best-effort; ignore */
  }
}
