/**
 * Smart-plan creation flow controller.
 *
 * The conversation is a schedule-owned independent agent session
 * (schedule.agentStart/agentSend/agentState) persisted under the schedule
 * root — it never enters any workspace's session list and never touches the
 * workspace service graph. The backlog (待办) keeps { sessionId, sessionPath }
 * so a reopen renders the transcript and can continue via
 * schedule.agentSend (resident) or schedule.agentContinue (after a host
 * restart, fork from the persisted file).
 */
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { markAgentSessionHandled, useScheduleAgentStore } from "./schedule-agent-store";

/** 用户显式选择的分析会话模型（含思考深度）；null = 宿主默认模型。 */
export type ScheduleModelChoice = {
  provider: string;
  id: string;
  thinkingLevel?: string;
} | null;

export type ScheduleAgentStartResult = { ok: true } | { ok: false; error: string };

const START_TIMEOUT_MS = 60_000;

/** Start a fresh smart-creation conversation (schedule-owned session). The
 *  optional model drives the analysis session itself. */
export async function startScheduleAgent(
  requirement: string,
  cwd: string,
  model: ScheduleModelChoice = null,
): Promise<ScheduleAgentStartResult> {
  const host = useAppStore.getState().host;
  if (!host) return { ok: false, error: "host not ready" };

  useScheduleAgentStore.getState().start({ sessionPath: null, sessionId: null });

  const response = await hostClient.request(
    "schedule.agentStart",
    hostContext(host),
    { cwd, requirement, model },
    START_TIMEOUT_MS,
  );
  if (!response.ok) {
    useScheduleAgentStore.getState().finish();
    return { ok: false, error: response.error?.message ?? "schedule.agentStart failed" };
  }
  useScheduleAgentStore.getState().start({
    sessionId: response.result.sessionId,
    sessionPath: response.result.sessionPath,
  });
  return { ok: true };
}

/** Reopen a backlog (待办) conversation. Pure frontend bookkeeping: the agent
 *  page pulls the transcript from the session file (or resident state). */
export function reopenScheduleAgent(entry: {
  sessionId: string;
  sessionPath: string;
}): ScheduleAgentStartResult {
  useScheduleAgentStore.getState().start({
    sessionId: entry.sessionId,
    sessionPath: entry.sessionPath,
  });
  return { ok: true };
}

/** Leave the agent page. A session with a confirmed plan (`created`) is marked
 *  handled so it drops out of the backlog; an unfinished one simply stays
 *  listed (the Host enumerates the session files, so nothing needs writing). */
export function leaveScheduleAgent(): void {
  const agent = useScheduleAgentStore.getState();
  if (agent.created && agent.sessionPath) {
    markAgentSessionHandled(agent.sessionPath);
  }
  useScheduleAgentStore.getState().finish();
}
