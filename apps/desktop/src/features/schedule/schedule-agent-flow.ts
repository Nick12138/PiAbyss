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
import {
  markAgentSessionHandled,
  useScheduleAgentStore,
} from "./schedule-agent-store";

export function schedulePlanPreamble(requirement: string, cwd: string): string {
  return [
    "你是「周期计划」智能创建助手，帮用户把需求变成一个定时任务（计划）配置。",
    "",
    "规则：",
    "1. 通过对话逐步确认配置；信息足够时可直接给出完整配置让用户确认。",
    "2. 只在用户明确要求查看配置或确认最终方案时，才输出 ```schedule-plan 代码块。平时对话中不要重复输出，右侧预览面板会实时显示当前配置。",
    "3. 配置 JSON 字段：",
    '   name: string 计划名；',
    '   kind: "prompt" | "command"（prompt=走模型的计划书任务；command=直接执行 shell 命令）；',
    '   prompt: string（kind=prompt 时的计划书内容，这是最关键的字段，描述周期任务要做什么；kind=command 时为 ""）；',
    "   command: string | null（kind=command 时的 shell 命令，否则 null）；",
    "   cwd: string 工作目录绝对路径；",
    '   trigger: { "type": "manual" } | { "type": "once", "at": "<ISO时间>" } | { "type": "interval", "every": "<数字><s|m|h|d|w|mo>" } | { "type": "cron", "cron": "<5段表达式>", "timezone"?: string }；',
    '   permission: "read_only" | "write" | "full"（仅 kind=prompt 有意义）；',
    '   model: { "provider": string, "id": string } | null（null=宿主默认模型）；',
    '   missedWindow: "catch_up_one" | "skip"；',
    "   timeoutMs: number（毫秒，默认 1800000）；",
    "   maxRuns: number | null；",
    "   tags: string[]；",
    '   notify: "none" | "system" | "tg"（运行结束的推送方式）；',
    '   loadExtensions: boolean（是否加载扩展，默认 false）。',
    "4. 用户没有明确表达的字段保持 null，不要臆造。",
    "5. prompt 字段是最重要的，需要详细描述任务内容、目标和要求。",
    "6. 最终创建由用户在预览面板点「确认创建」完成，你不要声称已经创建成功。",
    "",
    "用户需求：",
    requirement,
    "",
    `计划的默认工作目录（cwd）：${cwd}`,
  ].join("\n");
}

export type ScheduleAgentStartResult = { ok: true } | { ok: false; error: string };

const START_TIMEOUT_MS = 60_000;

/** Start a fresh smart-creation conversation (schedule-owned session). */
export async function startScheduleAgent(
  requirement: string,
  cwd: string,
): Promise<ScheduleAgentStartResult> {
  const host = useAppStore.getState().host;
  if (!host) return { ok: false, error: "host not ready" };

  useScheduleAgentStore.getState().start({ sessionPath: null, sessionId: null });

  const response = await hostClient.request(
    "schedule.agentStart",
    hostContext(host),
    { cwd, requirement },
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
