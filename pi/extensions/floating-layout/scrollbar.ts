/**
 * Unicode vertical scrollbar column.
 *
 * Given viewport geometry, return an array of `height` single-character strings
 * representing the scrollbar column (from top to bottom).
 */
export interface ScrollbarInput {
  height: number;
  scrollTop: number;
  viewSize: number;
  total: number;
  theme?: any;
}

export function renderScrollbarColumn(input: ScrollbarInput): string[] {
  const { height, scrollTop, viewSize, total, theme } = input;
  const track = "│";
  const thumb = "█";
  const tracked = (s: string) => (theme ? theme.fg("borderMuted", s) : s);
  const active = (s: string) => (theme ? theme.fg("accent", s) : s);

  if (height <= 0) return [];
  if (total <= viewSize || total <= 0) {
    return Array.from({ length: height }, () => tracked(track));
  }
  const thumbH = Math.max(1, Math.round((height * viewSize) / total));
  const maxThumbStart = Math.max(0, height - thumbH);
  const maxScroll = Math.max(1, total - viewSize);
  const thumbStart = Math.min(maxThumbStart, Math.round((maxThumbStart * scrollTop) / maxScroll));

  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    if (i >= thumbStart && i < thumbStart + thumbH) out.push(active(thumb));
    else out.push(tracked(track));
  }
  return out;
}
