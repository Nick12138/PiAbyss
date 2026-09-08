import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";

/**
 * Cached projection of one session JSONL file, mirroring what the SDK's
 * SessionManager.list extracts (header id/cwd/parent, latest session_info
 * name, message count, first user message, activity timestamps) without
 * re-parsing every file on every listing.
 *
 * The SDK's SessionInfo also carries allMessagesText (the whole transcript
 * joined); no Host consumer reads it, so the projection omits it to bound
 * memory.
 */
export type SessionListProjection = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  createdMs: number;
  modifiedMs: number;
  messageCount: number;
  firstMessage: string;
};

type CachedProjection = {
  mtimeMs: number;
  size: number;
  /** null = parsed but not a usable session file; cached so bad files are not re-read. */
  projection: SessionListProjection | null;
};

/**
 * Keyed by resolved absolute path: `path.resolve` normalizes separators and
 * `..` segments (but NOT letter casing on Windows), and every producer in
 * this codebase feeds paths from the same readdir listing, so entries stay
 * consistent.
 */
const projectionCache = new Map<string, CachedProjection>();

/**
 * Debounced UI refreshes re-list within moments of each other; a short-lived
 * stat/listing snapshot turns those into pure in-memory scans. Worst case a
 * result is TTL_MS stale, which listing UX tolerates.
 */
const TTL_MS = 2_000;

export type SessionFileStat = {
  mtimeMs: number;
  size: number;
  /** Needed for the created fallback when the header has no timestamp. */
  birthtimeMs: number;
  ctimeMs: number;
};

type CachedStat = SessionFileStat & { atMs: number };

const statCache = new Map<string, CachedStat>();

export async function statWithTtl(path: string): Promise<SessionFileStat> {
  const key = pathResolve(path);
  const now = Date.now();
  const cached = statCache.get(key);
  if (cached && now - cached.atMs <= TTL_MS) {
    return {
      mtimeMs: cached.mtimeMs,
      size: cached.size,
      birthtimeMs: cached.birthtimeMs,
      ctimeMs: cached.ctimeMs,
    };
  }
  const fileStat = await stat(path);
  const entry: CachedStat = {
    atMs: now,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    birthtimeMs: fileStat.birthtimeMs,
    ctimeMs: fileStat.ctimeMs,
  };
  statCache.set(key, entry);
  return entry;
}

type CachedListing = { atMs: number; files: string[] };

/** Sequential readdirs dominated warm-listing latency; cache listings per dir. */
const listingCache = new Map<string, CachedListing>();

/**
 * Shared per-directory JSONL listing with the same 2s TTL semantics as
 * statWithTtl. Only regular files are listed (directories named *.jsonl are
 * ignored); a missing directory yields [].
 */
export async function listJsonlFilesWithTtl(dir: string): Promise<string[]> {
  const key = pathResolve(dir);
  const now = Date.now();
  const cached = listingCache.get(key);
  if (cached && now - cached.atMs <= TTL_MS) return cached.files;
  let entries;
  try {
    entries = await readdir(key, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
    .map((entry) => join(key, entry.name));
  listingCache.set(key, { atMs: now, files });
  return files;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
  }
  return texts.join(" ");
}

function messageActivityMs(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  const messageTimestamp = message.timestamp;
  if (typeof messageTimestamp === "number") return messageTimestamp;
  const entryTimestamp = entry.timestamp;
  if (typeof entryTimestamp === "number") return entryTimestamp;
  if (typeof entryTimestamp === "string") {
    const parsed = new Date(entryTimestamp).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Stream-parse one session file. Returns null when the file is not a usable
 * session (first parseable line is not a session header) — matching the SDK's
 * buildSessionInfo, except that malformed message entries are tolerated
 * instead of discarding the whole file.
 */
async function parseSessionProjection(
  sessionPath: string,
  fileStat: SessionFileStat,
): Promise<SessionListProjection | null> {
  let header: {
    id: string;
    cwd: string;
    timestamp?: string;
    parentSession?: string;
  } | null = null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivityMs: number | undefined;

  const lines = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string") return null;
      header = {
        id: entry.id,
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
        ...(typeof entry.parentSession === "string" ? { parentSession: entry.parentSession } : {}),
      };
      continue;
    }
    if (entry.type === "session_info") {
      // Latest session_info wins, including explicit clears.
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount += 1;
    const message = entry.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (!("content" in record)) continue;
    const activity = messageActivityMs(entry, record);
    if (activity !== undefined) lastActivityMs = Math.max(lastActivityMs ?? 0, activity);
    const text = extractTextContent(record.content);
    if (!text) continue;
    if (!firstMessage && record.role === "user") firstMessage = text;
  }

  if (!header) return null;

  const headerTime = header.timestamp ? new Date(header.timestamp).getTime() : Number.NaN;
  const modifiedMs =
    lastActivityMs !== undefined && lastActivityMs > 0
      ? lastActivityMs
      : Number.isNaN(headerTime)
        ? fileStat.mtimeMs
        : headerTime;
  // SDK parity would yield an Invalid Date for headers without a timestamp;
  // fall back to filesystem timestamps instead so sorting stays meaningful.
  let createdMs = headerTime;
  if (Number.isNaN(createdMs) || createdMs <= 0) {
    createdMs = fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.ctimeMs;
  }
  if (Number.isNaN(createdMs) || createdMs <= 0) {
    createdMs = fileStat.mtimeMs;
  }

  return {
    path: sessionPath,
    id: header.id,
    cwd: header.cwd,
    ...(name !== undefined ? { name } : {}),
    ...(header.parentSession !== undefined ? { parentSessionPath: header.parentSession } : {}),
    createdMs,
    modifiedMs,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
  };
}

let parseCount = 0;

/** Test observability: number of full file parses (cache misses) so far. */
export function sessionListProjectionParseCountForTests(): number {
  return parseCount;
}

async function projectionForFile(sessionPath: string): Promise<SessionListProjection | null> {
  const key = pathResolve(sessionPath);
  let fileStat: SessionFileStat;
  try {
    fileStat = await statWithTtl(key);
  } catch (error) {
    // A file listed by the (briefly cached) directory snapshot may have been
    // deleted or archived since; treat it as absent instead of failing.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      projectionCache.delete(key);
      statCache.delete(key);
      return null;
    }
    throw error;
  }
  const cached = projectionCache.get(key);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.projection ? { ...cached.projection } : null;
  }
  parseCount += 1;
  const projection = await parseSessionProjection(key, fileStat);
  projectionCache.set(key, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, projection });
  return projection ? { ...projection } : null;
}

/**
 * List session projections for one directory. Directory listings and per-file
 * stats are cached with a short TTL; files are re-parsed only when their
 * (mtimeMs, size) signature changes. Cached projections are cloned before
 * being returned, so callers cannot mutate the cache.
 */
export async function listSessionProjectionsFromDir(dir: string): Promise<SessionListProjection[]> {
  const files = await listJsonlFilesWithTtl(dir);
  const projections = await Promise.all(files.map((file) => projectionForFile(file)));
  return projections.filter(
    (projection): projection is SessionListProjection => projection !== null,
  );
}

/**
 * Drop cached projections/stats/listings. With a path, evicts that file and
 * its parent directory snapshot (rename/deletion change the file set); without
 * one, clears everything — correctness over cache warmth.
 */
export function invalidateSessionListProjection(filePath?: string): void {
  if (filePath === undefined) {
    projectionCache.clear();
    statCache.clear();
    listingCache.clear();
    return;
  }
  const key = pathResolve(filePath);
  projectionCache.delete(key);
  statCache.delete(key);
  listingCache.delete(pathResolve(dirname(key)));
}

/** Test hook: drops all memoized projections/stats/listings so the next list reflects disk. */
export function resetSessionListProjectionCachesForTests(): void {
  projectionCache.clear();
  statCache.clear();
  listingCache.clear();
}
