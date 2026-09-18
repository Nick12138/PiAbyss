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
  /** Set after the plan was confirmed & created (hides it from the backlog). */
  created: boolean;
  start: (input: { sessionId: string | null; sessionPath: string | null }) => void;
  setSession: (input: { sessionId: string; sessionPath: string }) => void;
  markCreated: () => void;
  finish: () => void;
};

export const useScheduleAgentStore = create<ScheduleAgentState>((set) => ({
  sessionId: null,
  sessionPath: null,
  created: false,
  start: ({ sessionId, sessionPath }) => set({ sessionId, sessionPath, created: false }),
  setSession: ({ sessionId, sessionPath }) => set({ sessionId, sessionPath }),
  markCreated: () => set({ created: true }),
  finish: () => set({ sessionId: null, sessionPath: null, created: false }),
}));

/* ── Backlog（待办）───────────────────────────────────────────────
 *
 * The list itself comes from the Host (schedule.agentList scans the
 * agent-sessions directory), so a session is never lost just because the user
 * left the page some other way. The frontend only remembers which sessions
 * the user already handled (confirmed into a plan, or dismissed manually):
 * those are filtered out of the list.
 *
 * This replaces the old localStorage-only backlog, which was written solely
 * by the agent page's back button and therefore silently dropped every
 * session the user left through another path.
 */

const HANDLED_KEY = "piabyss.schedule.agentHandled.v1";

/** Session paths the user has confirmed or dismissed. */
export function listHandledAgentSessions(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(HANDLED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** Mark a session as handled so it leaves the backlog. Idempotent. */
export function markAgentSessionHandled(sessionPath: string): void {
  if (!sessionPath) return;
  const list = listHandledAgentSessions();
  if (list.includes(sessionPath)) return;
  list.push(sessionPath);
  try {
    globalThis.localStorage?.setItem(HANDLED_KEY, JSON.stringify(list));
  } catch {
    /* unavailable */
  }
}
