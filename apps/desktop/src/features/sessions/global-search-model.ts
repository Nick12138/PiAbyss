import type { SessionSearchResultItem } from "@piabyss/protocol";

export type HighlightSegment = { text: string; matched: boolean };

/** Mirror of the Host's query normalization so highlights match its results. */
export function searchQueryTerms(query: string): string[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(terms)].slice(0, 8);
}

export function highlightSegments(text: string, terms: string[]): HighlightSegment[] {
  if (!text || terms.length === 0) return [{ text, matched: false }];
  const lower = text.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const index = lower.indexOf(term, from);
      if (index < 0) break;
      ranges.push([index, index + term.length]);
      from = index + term.length;
    }
  }
  if (ranges.length === 0) return [{ text, matched: false }];
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), matched: false });
    segments.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });
  return segments;
}

export type WorkspaceResultGroup = {
  cwd: string;
  items: SessionSearchResultItem[];
};

/** Groups keep the report's recency order: a workspace appears at its newest hit. */
export function groupResultsByWorkspace(items: SessionSearchResultItem[]): WorkspaceResultGroup[] {
  const groups = new Map<string, WorkspaceResultGroup>();
  for (const item of items) {
    let group = groups.get(item.cwd);
    if (!group) {
      group = { cwd: item.cwd, items: [] };
      groups.set(item.cwd, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

export function shouldRunGlobalSearch(query: string): boolean {
  return query.trim().length >= 1;
}
