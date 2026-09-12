import type { SessionSnapshot, SessionSummary } from "@piabyss/protocol";
import type { SessionCatalogEntry, SessionRuntimeState } from "../../lib/stores/session-catalog";
import type { SessionTerminalState } from "../../lib/session-terminal-states";

export type SessionFilter = "active" | "archived";

export function includeActiveSession(
  items: SessionSummary[],
  active: SessionSnapshot | null,
): SessionSummary[] {
  if (!active?.sessionPath || active.messages.length === 0) return items;
  const listed = items.find((item) => item.sessionId === active.sessionId);
  const current: SessionSummary = {
    sessionId: active.sessionId,
    sessionPath: active.sessionPath,
    name: active.name,
    cwd: active.cwd,
    updatedAt: listed?.updatedAt ?? Date.now(),
    messageCount: active.messages.length,
  };
  return [current, ...items.filter((item) => item.sessionId !== active.sessionId)];
}

/** Callers must pass the localized untitled label so search/render match the UI locale. */
export function sessionDisplayName(item: Pick<SessionSummary, "name">, fallback: string): string {
  return item.name?.trim() || fallback;
}

export type SessionStatusLabelKey =
  "sessionsStatusRunning" | "sessionsStatusQueued" | "sessionsStatusError" | "sessionsStatusDone";

export function sessionStatusLabelKey(
  runtimeState: SessionRuntimeState,
  terminal: SessionTerminalState | undefined,
): SessionStatusLabelKey | null {
  if (runtimeState === "running") return "sessionsStatusRunning";
  if (runtimeState === "queued") return "sessionsStatusQueued";
  if (terminal?.state === "error" && !terminal.acknowledged) return "sessionsStatusError";
  if (runtimeState === "error" && !terminal) return "sessionsStatusError";
  if (terminal?.state === "done" && !terminal.acknowledged) return "sessionsStatusDone";
  return null;
}

/**
 * Dot color for states worth surfacing; quiet states render nothing.
 * Active (focused) and inactive sessions surface the same visual states:
 * live states (running/queued) show while busy, and terminal states (error/done)
 * show until the user sends a new command (which starts a new run) or leaves
 * the session (which acknowledges and clears the terminal marker).
 */
export function sessionStatusDotClass(
  runtimeState: SessionRuntimeState,
  terminal: SessionTerminalState | undefined,
): string | null {
  if (runtimeState === "running") return "bg-success status-dot-pulse";
  if (runtimeState === "queued") return "bg-warning status-dot-pulse";
  if (terminal?.state === "error" && !terminal.acknowledged) return "bg-danger status-dot-pulse";
  if (runtimeState === "error" && !terminal) return "bg-danger status-dot-pulse";
  if (terminal?.state === "done" && !terminal.acknowledged) return "bg-muted status-dot-pulse";
  return null;
}

export function filterSessionItems(
  items: SessionCatalogEntry[],
  filter: SessionFilter,
): SessionCatalogEntry[] {
  return items.filter((item) => (filter === "archived" ? item.archived : !item.archived));
}

export type SessionTimeGroup = "today" | "thisWeek" | "earlier";

/** Millisecond start-of-day boundary. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Millisecond start-of-week boundary (Monday 00:00). */
function startOfWeek(now: number): number {
  const d = new Date(startOfDay(now));
  const day = d.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

function sessionSortTime(item: SessionCatalogEntry): number {
  return item.createdAt ?? item.updatedAt;
}

function sessionTimeGroup(sortTime: number, now: number = Date.now()): SessionTimeGroup {
  if (sortTime >= startOfDay(now)) return "today";
  if (sortTime >= startOfWeek(now)) return "thisWeek";
  return "earlier";
}

/** Split already-sorted (newest first) items into time buckets. */
export function groupSessionItemsByTime(
  items: SessionCatalogEntry[],
  now: number = Date.now(),
): { group: SessionTimeGroup; items: SessionCatalogEntry[] }[] {
  const buckets: Record<SessionTimeGroup, SessionCatalogEntry[]> = {
    today: [],
    thisWeek: [],
    earlier: [],
  };
  for (const item of items) {
    buckets[sessionTimeGroup(sessionSortTime(item), now)].push(item);
  }
  return (["today", "thisWeek", "earlier"] as SessionTimeGroup[]).map((group) => ({
    group,
    items: buckets[group],
  }));
}

export function canRenameSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  // Archived Sessions live in the archive directory and are excluded from the
  // active list's mutations; renaming one would silently write to a file the
  // user cannot currently see.
  if (item.archived) return false;
  // Renaming is metadata-only and is safe while the current Session is
  // running. Background runtimes remain excluded because their live snapshot
  // is not the foreground editing target.
  if (session?.sessionId === item.sessionId) return true;
  return item.runtimeState === "inactive" || item.runtimeState === "error";
}

/** Busy states cover a run that is active or about to start; everything else is safe to mutate. */
function isSessionRuntimeBusy(state: SessionRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "queued";
}

export function canArchiveSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  if (item.archived) return false;
  if (session?.sessionId === item.sessionId) return session.isIdle;
  return !isSessionRuntimeBusy(item.runtimeState);
}

/**
 * Export reads the Session JSONL file, so a Session that is still appending to
 * it must finish first. Archived Sessions are static files and always safe.
 */
export function canExportSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  if (item.archived) return true;
  if (session?.sessionId === item.sessionId) return session.isIdle;
  return !isSessionRuntimeBusy(item.runtimeState);
}

export function canDeleteSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  if (item.archived) return true;
  if (session?.sessionId === item.sessionId) return session.isIdle;
  return !isSessionRuntimeBusy(item.runtimeState);
}

export function shouldClearLastSessionPath(
  lastSessionPath: string,
  removedSessionPath: string,
): boolean {
  return lastSessionPath === removedSessionPath;
}

export function removedArchivedSessionIds(
  before: readonly Pick<SessionCatalogEntry, "sessionId" | "archived">[],
  after: readonly Pick<SessionCatalogEntry, "sessionId" | "archived">[],
): string[] {
  const remaining = new Set(after.map((item) => item.sessionId));
  return before
    .filter((item) => item.archived && !remaining.has(item.sessionId))
    .map((item) => item.sessionId);
}

export function shouldRetrySessionRpc(error: { code?: string; retryable?: boolean }): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

/** Short-lived sdk.read locks make SERVICE_GRAPH_BUSY transient; retry briefly. */
export async function requestSessionRpcWithRetry<
  T extends { ok: true } | { ok: false; error: { code?: string; retryable?: boolean } },
>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    if (response.ok || !shouldRetrySessionRpc(response.error) || attempt === 4) {
      return response;
    }
    await wait(80 * (attempt + 1));
  }
}
