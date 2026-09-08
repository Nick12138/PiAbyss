import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import {
  stripAttachmentReferenceBlocks,
  type SessionSearchMatch,
  type SessionSearchReport,
  type SessionSearchResultItem,
} from "@piabyss/protocol";
import { piabyssDataDir } from "./piabyss-data.js";
import {
  invalidateSessionListProjection,
  listJsonlFilesWithTtl,
  resetSessionListProjectionCachesForTests,
  statWithTtl,
} from "./session-list-projection.js";

const DEFAULT_RESULT_LIMIT = 50;
const MAX_MATCHES_PER_SESSION = 3;
const MAX_QUERY_TERMS = 8;
const MAX_BLOCKS_PER_SESSION = 5000;
/** Long assistant messages are truncated for search; snippets stay early-anchored. */
const MAX_BLOCK_CHARS = 20_000;
/** Total searchable text cached per session file; bounds Host memory. */
const MAX_DOC_CHARS = 262_144;
const SNIPPET_BEFORE_CHARS = 40;
const SNIPPET_AFTER_CHARS = 120;

type SearchBlock = {
  role: "user" | "assistant";
  text: string;
  /** Lowercased once at parse time so repeated searches allocate nothing. */
  lower: string;
};

type SearchDoc = {
  sessionId: string;
  name?: string;
  nameLower?: string;
  cwd: string;
  blocks: SearchBlock[];
};

type CachedSearchDoc = {
  mtimeMs: number;
  size: number;
  doc: SearchDoc | null;
};

const docCache = new Map<string, CachedSearchDoc>();

/**
 * Debounced keystrokes re-search within moments of each other; a short-lived
 * listing snapshot turns those into pure in-memory scans. Worst case a result
 * is STAT_TTL_MS stale, which search UX tolerates. Per-file stats and per-dir
 * JSONL listings are memoized by the shared session-list projection module.
 */
const STAT_TTL_MS = 2_000;

type CachedListing = { atMs: number; files: string[] };

/** Sequential readdirs dominated warm-search latency; cache listings per root. */
const listingCache = new Map<string, CachedListing>();

/** Test hook: drops memoized docs/listings (and the shared stat/projection caches) so the next scan reflects disk immediately. */
export function resetSessionSearchCaches(): void {
  docCache.clear();
  listingCache.clear();
  resetSessionListProjectionCachesForTests();
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function textBlocksOf(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      texts.push(block.text);
    }
  }
  return texts;
}

/**
 * Cheap pre-filter before JSON.parse. Session files are SDK-written compact
 * JSON, so every line this module must handle necessarily contains one of
 * these field literals. False positives (a text body embedding a literal)
 * only cost one harmless parse; lines skipped here are the tool-result and
 * bookkeeping entries that dominate file size.
 */
function mayContainSearchableEntry(line: string): boolean {
  return (
    line.includes('"role":"user"') ||
    line.includes('"role":"assistant"') ||
    line.includes('"type":"session"') ||
    line.includes('"type":"session_info"')
  );
}

async function parseSearchDoc(sessionPath: string): Promise<SearchDoc | null> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let name: string | undefined;
  let totalChars = 0;
  const blocks: SearchBlock[] = [];

  const lines = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!mayContainSearchableEntry(line)) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "session" && sessionId === null && isUuid(entry.id)) {
      sessionId = entry.id;
      cwd = typeof entry.cwd === "string" ? entry.cwd : null;
      continue;
    }
    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (
      entry.type !== "message" ||
      blocks.length >= MAX_BLOCKS_PER_SESSION ||
      totalChars >= MAX_DOC_CHARS
    ) {
      continue;
    }
    if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) {
      continue;
    }
    const message = entry.message as Record<string, unknown>;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    for (const rawText of textBlocksOf(message.content)) {
      const stripped = role === "user" ? stripAttachmentReferenceBlocks(rawText) : rawText;
      if (!stripped.trim()) continue;
      const text = stripped.slice(0, Math.min(MAX_BLOCK_CHARS, MAX_DOC_CHARS - totalChars));
      if (!text) break;
      totalChars += text.length;
      blocks.push({ role, text, lower: text.toLocaleLowerCase() });
      if (blocks.length >= MAX_BLOCKS_PER_SESSION || totalChars >= MAX_DOC_CHARS) break;
    }
  }

  if (!sessionId || !cwd) return null;
  return {
    sessionId,
    ...(name ? { name, nameLower: name.toLocaleLowerCase() } : {}),
    cwd,
    blocks,
  };
}

export function normalizeQueryTerms(query: string): string[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

function matchesAllTerms(lowerText: string, terms: string[]): boolean {
  return terms.every((term) => lowerText.includes(term));
}

export function buildSnippet(text: string, firstTerm: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const index = collapsed.toLocaleLowerCase().indexOf(firstTerm);
  const start = index < 0 ? 0 : Math.max(0, index - SNIPPET_BEFORE_CHARS);
  const end =
    index < 0
      ? SNIPPET_AFTER_CHARS
      : Math.min(collapsed.length, index + firstTerm.length + SNIPPET_AFTER_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${collapsed.slice(start, end)}${suffix}`;
}

function matchDoc(
  doc: SearchDoc,
  terms: string[],
): { nameMatched: boolean; matchCount: number; matches: SessionSearchMatch[] } | null {
  const nameMatched = doc.nameLower !== undefined && matchesAllTerms(doc.nameLower, terms);
  let matchCount = 0;
  const matches: SessionSearchMatch[] = [];
  for (const block of doc.blocks) {
    if (!matchesAllTerms(block.lower, terms)) continue;
    matchCount += 1;
    if (matches.length < MAX_MATCHES_PER_SESSION) {
      matches.push({ role: block.role, snippet: buildSnippet(block.text, terms[0] ?? "") });
    }
  }
  if (!nameMatched && matchCount === 0) return null;
  return { nameMatched, matchCount, matches };
}

async function listWorkspaceDirs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function listSessionFilesUnder(root: string): Promise<string[]> {
  const now = Date.now();
  const cached = listingCache.get(root);
  if (cached && now - cached.atMs <= STAT_TTL_MS) return cached.files;
  const dirs = await listWorkspaceDirs(root);
  const perDir = await Promise.all(dirs.map((dir) => listJsonlFilesWithTtl(dir)));
  const files = perDir.flat();
  listingCache.set(root, { atMs: now, files });
  return files;
}

async function loadDoc(
  sessionPath: string,
  seen: Set<string>,
): Promise<{ doc: SearchDoc | null; mtimeMs: number }> {
  seen.add(sessionPath);
  let fileStat;
  try {
    fileStat = await statWithTtl(sessionPath);
  } catch (error) {
    // A file listed by the (briefly cached) directory snapshot may have been
    // deleted or archived since; treat it as absent instead of failing, and
    // forget it in the shared caches so later scans do not retry it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      docCache.delete(sessionPath);
      invalidateSessionListProjection(sessionPath);
      return { doc: null, mtimeMs: 0 };
    }
    throw error;
  }
  const cached = docCache.get(sessionPath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return { doc: cached.doc, mtimeMs: fileStat.mtimeMs };
  }
  const doc = await parseSearchDoc(sessionPath);
  docCache.set(sessionPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, doc });
  return { doc, mtimeMs: fileStat.mtimeMs };
}

export async function searchSessions(args: {
  agentDir: string;
  query: string;
  limit?: number;
  includeArchived?: boolean;
}): Promise<SessionSearchReport> {
  const terms = normalizeQueryTerms(args.query);
  const limit = args.limit ?? DEFAULT_RESULT_LIMIT;
  const includeArchived = args.includeArchived !== false;

  // Paths returned by the shared listing are resolved, so keep the scan roots
  // in the same form (the docCache cleanup below prefixes against them).
  const sessionsRoot = pathResolve(join(args.agentDir, "sessions"));
  const archiveRoot = pathResolve(join(piabyssDataDir(args.agentDir), "session-archive"));
  const [activePaths, archivedPaths] = await Promise.all([
    listSessionFilesUnder(sessionsRoot),
    includeArchived ? listSessionFilesUnder(archiveRoot) : Promise.resolve([]),
  ]);
  const files: Array<{ path: string; archived: boolean }> = [
    ...activePaths.map((path) => ({ path, archived: false })),
    ...archivedPaths.map((path) => ({ path, archived: true })),
  ];

  const seen = new Set<string>();
  const items: SessionSearchResultItem[] = [];
  if (terms.length > 0) {
    for (let offset = 0; offset < files.length; offset += 8) {
      const batch = await Promise.all(
        files.slice(offset, offset + 8).map(async (file) => {
          const { doc, mtimeMs } = await loadDoc(file.path, seen);
          if (!doc) return null;
          const matched = matchDoc(doc, terms);
          if (!matched) return null;
          return {
            sessionId: doc.sessionId,
            sessionPath: file.path,
            ...(doc.name !== undefined ? { name: doc.name } : {}),
            cwd: doc.cwd,
            archived: file.archived,
            updatedAt: mtimeMs,
            matchCount: matched.matchCount,
            matches: matched.matches,
            nameMatched: matched.nameMatched,
          } satisfies SessionSearchResultItem;
        }),
      );
      for (const item of batch) if (item) items.push(item);
    }

    // Drop cache entries for files deleted since the previous search; archive
    // entries survive an active-only search because that root was not scanned.
    const scannedRoots = [sessionsRoot, ...(includeArchived ? [archiveRoot] : [])];
    for (const path of docCache.keys()) {
      if (!seen.has(path) && scannedRoots.some((root) => path.startsWith(root))) {
        // The doc is gone from every scanned workspace dir; forget its shared
        // stat snapshot as well.
        invalidateSessionListProjection(path);
        docCache.delete(path);
      }
    }
  }

  items.sort((left, right) => right.updatedAt - left.updatedAt);
  const truncated = items.length > limit;
  return {
    generatedAt: Date.now(),
    query: args.query,
    scannedCount: files.length,
    truncated,
    items: truncated ? items.slice(0, limit) : items,
  };
}
