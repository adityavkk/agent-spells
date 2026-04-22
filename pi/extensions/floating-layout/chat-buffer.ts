/**
 * ChatBuffer: event-driven flat line buffer for the chat viewport.
 *
 * MVP scope:
 * - holds an ordered list of "entries" (user/assistant/tool) keyed by id
 * - each entry exposes a plain-text representation that can be wrapped to width
 * - layout editor calls getLines(width) to get the flattened view
 *
 * Phase 2 will swap the plain-text formatter for pi-tui's Markdown / message
 * components for richer rendering. The interface stays the same.
 */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { wrapBlock } from "./util.js";

export type EntryKind = "user" | "assistant" | "tool";

interface Entry {
  id: string;
  kind: EntryKind;
  header: string;
  body: string;
  // Cache keyed by width; cleared on any update.
  cache?: { width: number; lines: string[] };
}

function messageText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const item of content) {
    if ("text" in item && typeof item.text === "string") parts.push(item.text);
    else if ("thinking" in item && typeof item.thinking === "string") {
      // Skip thinking in MVP; pi-thinking-steps owns that surface.
    } else if ("name" in item && "input" in item) {
      // tool call inside assistant message
      parts.push(`→ ${(item as any).name}(${JSON.stringify((item as any).input).slice(0, 200)})`);
    } else if ("type" in item && (item as any).type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n").trim();
}

function toolId(toolCallId: string): string {
  return `tool-${toolCallId}`;
}

export class ChatBuffer {
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private userCounter = 0;
  /** Id of the currently-streaming assistant message, if any. */
  private currentAssistantId: string | null = null;
  private assistantCounter = 0;
  /** Monotonic "version" bumped on any change; layout uses it to invalidate. */
  private _version = 0;
  get version(): number {
    return this._version;
  }

  clear(): void {
    this.entries = [];
    this.byId.clear();
    this.userCounter = 0;
    this.assistantCounter = 0;
    this.currentAssistantId = null;
    this._version++;
  }

  private upsert(entry: Entry): void {
    const existing = this.byId.get(entry.id);
    if (existing) {
      existing.header = entry.header;
      existing.body = entry.body;
      existing.cache = undefined;
    } else {
      this.byId.set(entry.id, entry);
      this.entries.push(entry);
    }
    this._version++;
  }

  /** message_start (role=user) OR resume backfill. Idempotent by content. */
  onUserMessage(msg: UserMessage): void {
    // Dedupe: if the last entry is a user message with identical body, skip.
    const body = messageText(msg.content);
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === "user" && last.body === body) return;
    const id = `user-${this.userCounter++}`;
    this.upsert({ id, kind: "user", header: "you", body });
  }

  /** message_start (role=assistant). Creates a fresh assistant entry. */
  onAssistantStart(msg: AssistantMessage): void {
    const id = `assistant-${this.assistantCounter++}`;
    this.currentAssistantId = id;
    this.upsert({ id, kind: "assistant", header: "assistant", body: messageText(msg.content) });
  }

  /** message_update (role=assistant). Updates the current streaming entry. */
  onAssistantUpdate(msg: AssistantMessage): void {
    if (!this.currentAssistantId) {
      // No message_start was seen (can happen with backfill); create one.
      this.onAssistantStart(msg);
      return;
    }
    const existing = this.byId.get(this.currentAssistantId);
    if (!existing) return;
    existing.body = messageText(msg.content);
    existing.cache = undefined;
    this._version++;
  }

  /** message_end (role=assistant). Finalize + clear streaming cursor. */
  onAssistantEnd(msg: AssistantMessage): void {
    if (this.currentAssistantId) {
      const existing = this.byId.get(this.currentAssistantId);
      if (existing) {
        existing.body = messageText(msg.content);
        existing.cache = undefined;
        this._version++;
      }
    } else {
      this.onAssistantStart(msg);
    }
    this.currentAssistantId = null;
  }

  onToolStart(toolCallId: string, toolName: string, args: any): void {
    const argsStr = typeof args === "string" ? args : JSON.stringify(args);
    this.upsert({
      id: toolId(toolCallId),
      kind: "tool",
      header: `tool: ${toolName}`,
      body: argsStr.length > 400 ? argsStr.slice(0, 400) + "…" : argsStr,
    });
  }

  onToolEnd(toolCallId: string, toolName: string, result: any, isError: boolean): void {
    const existing = this.byId.get(toolId(toolCallId));
    const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const header = `${isError ? "tool error" : "tool"}: ${toolName}`;
    if (existing) {
      existing.header = header;
      existing.body = body.length > 2000 ? body.slice(0, 2000) + "\n…" : body;
      existing.cache = undefined;
      this._version++;
    } else {
      this.upsert({ id: toolId(toolCallId), kind: "tool", header, body });
    }
  }

  onToolResult(msg: ToolResultMessage): void {
    // Associate with existing tool entry if we can find it; otherwise append as a fresh tool entry.
    const id = toolId(msg.toolCallId);
    const body = messageText(msg.content);
    const existing = this.byId.get(id);
    if (existing) {
      existing.body = body;
      existing.cache = undefined;
      this._version++;
    } else {
      this.upsert({ id, kind: "tool", header: "tool", body });
    }
  }

  /**
   * Return the flat list of visible lines, wrapped to `width` and prefixed
   * with a simple kind marker per entry.
   */
  getLines(width: number): string[] {
    const out: string[] = [];
    for (const entry of this.entries) {
      if (!entry.cache || entry.cache.width !== width) {
        entry.cache = { width, lines: renderEntry(entry, width) };
      }
      out.push(...entry.cache.lines);
    }
    return out;
  }
}

function renderEntry(entry: Entry, width: number): string[] {
  // Header line: "▎ you", "▎ assistant", "▎ tool: <name>"
  const header = `▎ ${entry.header}`;
  const bodyLines = wrapBlock(entry.body || "", Math.max(1, width - 2));
  const indented = bodyLines.map((l) => `  ${l}`);
  return [header, ...indented, ""];
}
