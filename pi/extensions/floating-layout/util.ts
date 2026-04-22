/**
 * Small ANSI/string helpers shared across floating-layout.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Pad a (possibly ANSI-colored) string to `width` visible cells with trailing spaces. */
export function padPlain(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w >= width) return truncateToWidth(s, width);
  return s + " ".repeat(width - w);
}

/** Split text into lines respecting embedded newlines. Does not word-wrap. */
export function splitLines(s: string): string[] {
  return s.replace(/\r\n?/g, "\n").split("\n");
}

/** Hard word-wrap a single logical line to `width` visible cells. */
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [""];
  const plain = stripAnsi(line);
  if (visibleWidth(plain) <= width) return [line];
  // Fallback: truncate-based splitter. Good enough for MVP.
  const out: string[] = [];
  let remaining = line;
  while (visibleWidth(stripAnsi(remaining)) > width) {
    const chunk = truncateToWidth(remaining, width);
    out.push(chunk);
    // Compute remaining by stripping chunk's visible prefix.
    const chunkPlain = stripAnsi(chunk);
    const remPlain = stripAnsi(remaining);
    const cut = remPlain.indexOf(chunkPlain) === 0 ? chunkPlain.length : 0;
    remaining = cut > 0 ? remaining.slice(cut) : "";
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

/** Word-wrap a block of text (may contain \n) to width. */
export function wrapBlock(text: string, width: number): string[] {
  return splitLines(text).flatMap((line) => wrapLine(line, width));
}
