/**
 * Sidebar renderer.
 *
 * MVP: static lines (app label, session summary, hints). Phase 2 can wire in
 * session list / model picker / tool history.
 */
import { truncateToWidth } from "@mariozechner/pi-tui";
import { padPlain } from "./util.js";

export interface SidebarInput {
  width: number;
  height: number;
  theme: any;
  label: string;
  sessionLabel?: string;
  modelLabel?: string;
  hints?: string[];
}

export function renderSidebar(input: SidebarInput): string[] {
  const { width, height, theme, label, sessionLabel, modelLabel, hints } = input;
  const lines: string[] = [];
  const accent = (s: string) => (theme ? theme.fg("accent", s) : s);
  const muted = (s: string) => (theme ? theme.fg("muted", s) : s);
  const dim = (s: string) => (theme ? theme.fg("dim", s) : s);

  lines.push(accent(truncateToWidth(` ${label}`, width)));
  lines.push("");
  if (sessionLabel) {
    lines.push(muted(truncateToWidth(" session", width)));
    lines.push(truncateToWidth(` ${sessionLabel}`, width));
    lines.push("");
  }
  if (modelLabel) {
    lines.push(muted(truncateToWidth(" model", width)));
    lines.push(truncateToWidth(` ${modelLabel}`, width));
    lines.push("");
  }
  if (hints && hints.length > 0) {
    lines.push(muted(truncateToWidth(" keys", width)));
    for (const h of hints) {
      lines.push(dim(truncateToWidth(` ${h}`, width)));
    }
  }

  // Pad to height
  while (lines.length < height) lines.push("");
  // Width-pad each line
  return lines.slice(0, height).map((l) => padPlain(l, width));
}
