/**
 * Per-session "unseen terminal event" states for the sidebar status dots.
 *
 * A session that finished (idle) or failed (error) while the user was not
 * looking at it should keep a marker until the user returns to it once.
 * The store keeps one entry per session: the terminal state plus whether the
 * user has acknowledged it (by opening the session). Entries are keyed by
 * workspace so switching workspaces never loses another workspace's markers.
 */

type SessionTerminalNotice = "done" | "error";

export type SessionTerminalState = {
  state: SessionTerminalNotice;
  acknowledged: boolean;
  /** Rust Host activity generation for cross-workspace terminal events. */
  generation?: number;
};

export type SessionTerminalSnapshot = {
  state: SessionTerminalNotice;
  generation: number;
};

export type SessionTerminalStates = Record<
  string, // workspaceId
  Record<string, SessionTerminalState> // sessionId → state
>;

const TERMINAL_STATES_KEY = "piabyss.sessions.terminalStates.v1";

function isSessionTerminalState(value: unknown): value is SessionTerminalState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.state === "done" || candidate.state === "error") &&
    typeof candidate.acknowledged === "boolean" &&
    (candidate.generation === undefined ||
      (typeof candidate.generation === "number" &&
        Number.isSafeInteger(candidate.generation) &&
        candidate.generation >= 0))
  );
}

export function readTerminalStates(): SessionTerminalStates {
  try {
    const raw = globalThis.localStorage?.getItem(TERMINAL_STATES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: SessionTerminalStates = {};
    for (const [workspaceId, sessions] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessions !== "object" || sessions === null) continue;
      const bySession: Record<string, SessionTerminalState> = {};
      for (const [sessionId, entry] of Object.entries(sessions as Record<string, unknown>)) {
        if (isSessionTerminalState(entry)) bySession[sessionId] = entry;
      }
      if (Object.keys(bySession).length > 0) result[workspaceId] = bySession;
    }
    return result;
  } catch {
    return {};
  }
}

function writeTerminalStates(states: SessionTerminalStates): void {
  try {
    globalThis.localStorage?.setItem(TERMINAL_STATES_KEY, JSON.stringify(states));
  } catch {
    /* ignore unavailable localStorage */
  }
}

/** Merge a single entry, returning a fresh map and persisting it. */
export function mergeTerminalState(
  current: SessionTerminalStates,
  workspaceId: string,
  sessionId: string,
  next: SessionTerminalState,
): SessionTerminalStates {
  const currentEntry = current[workspaceId]?.[sessionId];
  const resolvedNext =
    next.generation === undefined &&
    currentEntry?.state === next.state &&
    currentEntry.generation !== undefined
      ? { ...next, generation: currentEntry.generation }
      : next;
  if (
    currentEntry &&
    currentEntry.state === resolvedNext.state &&
    currentEntry.acknowledged === resolvedNext.acknowledged &&
    currentEntry.generation === resolvedNext.generation
  ) {
    return current;
  }
  const nextStates: SessionTerminalStates = {
    ...current,
    [workspaceId]: {
      ...current[workspaceId],
      [sessionId]: resolvedNext,
    },
  };
  writeTerminalStates(nextStates);
  return nextStates;
}

/**
 * Merge authoritative terminal markers from a background Host. Generations
 * prevent an acknowledgement for an earlier run from hiding a later one.
 */
export function mergeTerminalSnapshots(
  current: SessionTerminalStates,
  workspaceId: string,
  snapshots: Readonly<Record<string, SessionTerminalSnapshot>>,
): SessionTerminalStates {
  let changed = false;
  const bySession = { ...current[workspaceId] };
  for (const [sessionId, snapshot] of Object.entries(snapshots)) {
    const existing = bySession[sessionId];
    if (existing?.generation === snapshot.generation && existing.state === snapshot.state) {
      continue;
    }
    // A fetch may have started just before the user acknowledged an active
    // terminal event. Preserve that acknowledgement when its local event has
    // not received the Host generation yet; later runs have a known, different
    // generation and correctly become unacknowledged again.
    const preserveAcknowledgement =
      existing?.acknowledged === true &&
      existing.generation === undefined &&
      existing.state === snapshot.state;
    bySession[sessionId] = {
      state: snapshot.state,
      acknowledged: preserveAcknowledgement,
      generation: snapshot.generation,
    };
    changed = true;
  }
  if (!changed) return current;
  const nextStates = { ...current, [workspaceId]: bySession };
  writeTerminalStates(nextStates);
  return nextStates;
}

/** Drop entries for removed sessions (permanent delete / archive cleanup). */
export function removeTerminalStates(
  current: SessionTerminalStates,
  workspaceId: string,
  sessionIds: readonly string[],
): SessionTerminalStates {
  const bySession = current[workspaceId];
  if (!bySession) return current;
  const removed = new Set(sessionIds);
  const remaining = Object.fromEntries(
    Object.entries(bySession).filter(([sessionId]) => !removed.has(sessionId)),
  );
  if (Object.keys(remaining).length === Object.keys(bySession).length) return current;
  const nextStates: SessionTerminalStates = {
    ...current,
    [workspaceId]: remaining,
  };
  writeTerminalStates(nextStates);
  return nextStates;
}
