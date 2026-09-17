/**
 * Smart-plan creation flow state: the dedicated session that backs the
 * schedule-agent conversation page. Sessions live in the schedule root
 * workspace (~/.pi/schedule), so they never enter normal workspace session
 * lists.
 */
import { create } from "zustand";

export type ScheduleAgentState = {
  /** The smart-creation session currently driving the agent page. */
  sessionId: string | null;
  sessionPath: string | null;
  /** Pending-entry id when the session was reopened from the backlog. */
  pendingId: string | null;
  /** Set after the plan was confirmed & created (suppresses backlog write). */
  created: boolean;
  start: (input: { sessionId: string | null; sessionPath: string | null; pendingId?: string | null }) => void;
  setSession: (input: { sessionId: string; sessionPath: string }) => void;
  markCreated: () => void;
  finish: () => void;
};

export const useScheduleAgentStore = create<ScheduleAgentState>((set) => ({
  sessionId: null,
  sessionPath: null,
  pendingId: null,
  created: false,
  start: ({ sessionId, sessionPath, pendingId = null }) =>
    set({ sessionId, sessionPath, pendingId, created: false }),
  setSession: ({ sessionId, sessionPath }) => set({ sessionId, sessionPath }),
  markCreated: () => set({ created: true }),
  finish: () => set({ sessionId: null, sessionPath: null, pendingId: null, created: false }),
}));

/* ── Backlog（待办）：unfinished smart-creation sessions ─────────── */

export type ScheduleAgentPending = {
  /** Stable key; also the localStorage index. */
  id: string;
  /** The schedule-agent session id (host-resident while the host lives). */
  sessionId: string;
  /** Persisted transcript file under the schedule root. */
  sessionPath: string;
  name: string;
  createdAt: string;
};

const PENDING_KEY = "piabyss.schedule.agentPending.v1";

export function listAgentPending(): ScheduleAgentPending[] {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ScheduleAgentPending =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as ScheduleAgentPending).id === "string" &&
        typeof (item as ScheduleAgentPending).sessionPath === "string" &&
        typeof (item as ScheduleAgentPending).sessionId === "string",
    );
  } catch {
    return [];
  }
}

export function addAgentPending(entry: Omit<ScheduleAgentPending, "id" | "createdAt">): void {
  const list = listAgentPending().filter(
    (item) => item.sessionPath !== entry.sessionPath,
  );
  list.push({
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  });
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    /* unavailable */
  }
}

export function removeAgentPending(id: string): void {
  const list = listAgentPending().filter((item) => item.id !== id);
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    /* unavailable */
  }
}
