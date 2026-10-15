/**
 * 委派任务树（`pixie.taskTree`）：把委派注册表投影成「工作区 → 会话 → 任务」。
 *
 * 前端只渲染短名 + 四态，详细提示词与结束内容不进这棵树。每条任务带一个
 * `jump`：锚点在哪个会话就跳哪个——reportMessageId 落在小精灵段会话（回执
 * 注入的那条），dispatchMessageId 落在被委派会话（任务注入的那条）。老记录
 * 两个锚点都没有时 `messageId=null`：跳转退化成「打开会话」，不做滚动。
 */
import type {
  PixieDispatchRecord,
  PixieDispatchStatus,
  PixieTaskJump,
  PixieTaskStatus,
  PixieTaskTreeSession,
  PixieTaskTreeTask,
  PixieTaskTreeWorkspace,
} from "@piabyss/protocol";
import {
  clipPixieShortName,
  listDispatchesForPanel,
  resolvePixieWorkspacePath,
} from "./pixie-agent-runner.js";
import { listPixieSessions } from "./pixie-session-cache.js";

/**
 * 生命周期 → 对外四态。排队=还没进会话；进行中=已注入且未终态（含暂停等指令
 * 与等用户答复）；已完成=正常回执；失败=出错 / 被叫停 / 摘队列。
 */
export function pixieTaskStatusOf(status: PixieDispatchStatus): PixieTaskStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "reported":
      return "done";
    case "failed":
    case "stopped":
    case "cancelled":
      return "failed";
    default:
      return "running";
  }
}

/** 工作区标签：与前端工作区列表同口径（取路径最后一段目录名）。 */
export function pixieWorkspaceLabel(cwd: string): string {
  return cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd;
}

function activityOf(task: PixieTaskTreeTask): number {
  return task.lastActiveAt ?? task.createdAt;
}

/** 回执锚点的会话路径：小精灵段会话登记在会话缓存里，取不到交给前端解析。 */
function originSessionPath(agentDir: string, originSessionId: string): string | null {
  const pixieCwd = resolvePixieWorkspacePath(agentDir);
  const found = listPixieSessions(agentDir, pixieCwd).find(
    (entry) => entry.sessionId === originSessionId,
  );
  return found?.sessionPath || null;
}

/** 跳转目标：优先结果回执，其次派发消息，都没有就只带会话坐标（不滚动）。 */
function buildJump(agentDir: string, record: PixieDispatchRecord): PixieTaskJump {
  const reportMessageId = record.reportMessageId ?? null;
  const dispatchMessageId = record.dispatchMessageId ?? null;
  if (reportMessageId && record.originSessionId) {
    return {
      cwd: resolvePixieWorkspacePath(agentDir),
      sessionId: record.originSessionId,
      sessionPath: originSessionPath(agentDir, record.originSessionId),
      messageId: reportMessageId,
      anchor: "report",
    };
  }
  return {
    cwd: record.cwd,
    sessionId: record.sessionId,
    sessionPath: record.sessionPath,
    messageId: dispatchMessageId,
    anchor: dispatchMessageId ? "dispatch" : null,
  };
}

function buildTask(agentDir: string, record: PixieDispatchRecord): PixieTaskTreeTask {
  return {
    dispatchId: record.id,
    // 短名口径：小精灵传了 taskName 就用，没传用 task 前 ~20 字兜底。
    label: record.taskName || clipPixieShortName(record.task) || record.task,
    status: pixieTaskStatusOf(record.status),
    statusDetail: record.status,
    kind: record.kind,
    question: record.question,
    options: record.options,
    failCount: record.failCount,
    stale: record.stale,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
    dispatchMessageId: record.dispatchMessageId ?? null,
    reportMessageId: record.reportMessageId ?? null,
    jump: buildJump(agentDir, record),
  };
}

/**
 * 会话层标签：优先委派记录上的会话名（新建=本次采用的名字，复用=当时的现有名），
 * 其次该会话最早一条任务的前缀兜底，最后退回会话 id 前缀——面板上永远不该
 * 出现「新会话」。
 */
function sessionLabel(records: PixieDispatchRecord[]): string {
  const named = records.reduce<PixieDispatchRecord | null>(
    (latest, record) =>
      record.sessionName && (!latest || record.createdAt > latest.createdAt) ? record : latest,
    null,
  );
  if (named?.sessionName) return named.sessionName;
  const oldest = records.reduce<PixieDispatchRecord | null>(
    (earliest, record) => (!earliest || record.createdAt < earliest.createdAt ? record : earliest),
    null,
  );
  return oldest ? clipPixieShortName(oldest.task) || oldest.task : "";
}

/** 未落点记录（受理前就失败）归到这一节点，仍在工作区下可见。 */
const UNRESOLVED_SESSION_KEY = "";

/**
 * 组装任务树。归属过滤沿用委派面板语义（活跃跨段 + 当前段历史），与
 * `pixie.dispatches` 看到的是同一批记录，只是换了投影形状。
 * 排序：工作区 / 会话按最近活动倒序，任务按派发时间倒序。
 */
export function buildPixieTaskTree(
  agentDir: string,
  currentSessionId: string | null,
): PixieTaskTreeWorkspace[] {
  const records = listDispatchesForPanel(agentDir, currentSessionId);
  const byWorkspace = new Map<string, Map<string, PixieDispatchRecord[]>>();
  for (const record of records) {
    const sessions = byWorkspace.get(record.cwd) ?? new Map<string, PixieDispatchRecord[]>();
    const key = record.sessionId ?? record.sessionPath ?? UNRESOLVED_SESSION_KEY;
    const group = sessions.get(key) ?? [];
    group.push(record);
    sessions.set(key, group);
    byWorkspace.set(record.cwd, sessions);
  }

  const ranked: { peak: number; workspace: PixieTaskTreeWorkspace }[] = [];
  for (const [cwd, sessions] of byWorkspace) {
    const sessionNodes: PixieTaskTreeSession[] = [];
    for (const [sessionId, sessionRecords] of sessions) {
      const tasks = sessionRecords
        .slice()
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((record) => buildTask(agentDir, record));
      const label = sessionId
        ? sessionLabel(sessionRecords) || `会话 ${sessionId.slice(0, 8)}`
        : pixieWorkspaceLabel(cwd);
      sessionNodes.push({ sessionId, label, tasks });
    }
    sessionNodes.sort(
      (left, right) =>
        peakActivity(right) - peakActivity(left) || right.tasks.length - left.tasks.length,
    );
    ranked.push({
      peak: sessionNodes.reduce((peak, node) => Math.max(peak, peakActivity(node)), 0),
      workspace: { cwd, workspaceLabel: pixieWorkspaceLabel(cwd), sessions: sessionNodes },
    });
  }
  return ranked.sort((left, right) => right.peak - left.peak).map((entry) => entry.workspace);
}

/** 会话节点的峰值活动（排序键）：任务里最近的一次活动时间。 */
function peakActivity(node: PixieTaskTreeSession): number {
  return node.tasks.reduce((peak, task) => Math.max(peak, activityOf(task)), 0);
}
