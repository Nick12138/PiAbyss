/**
 * 委派任务树（`pixie.taskTree`）：把委派注册表投影成「工作区 → 会话 → 任务」。
 *
 * 前端只渲染短名 + 四态，详细提示词与结束内容不进这棵树；跳转按会话给，坐标就是
 * 每行的 cwd + sessionId，所以这里不再产出消息锚点（记录里的 dispatchMessageId /
 * reportMessageId 字段留着，只是没人再写它）。
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  PixieDispatchRecord,
  PixieDispatchStatus,
  PixieSessionLiveness,
  PixieTaskStatus,
  PixieTaskTreeSession,
  PixieTaskTreeTask,
  PixieTaskTreeWorkspace,
} from "@piabyss/protocol";
import { clipPixieShortName, listDispatchesForPanel } from "./pixie-agent-runner.js";
import { sessionStorageDirs } from "./session-storage.js";

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

/**
 * 展示档位的先后：在跑的最前，其次要看的失败，再往下是排队，已完成沉底——
 * 面板是扫一眼用的，历史不该占住视线顶端。
 */
const PIXIE_TASK_RANK: Record<PixieTaskStatus, number> = {
  running: 0,
  failed: 1,
  queued: 2,
  done: 3,
};

/**
 * 同档内按派发时间倒序（新的在上），唯独排队档按正序：那一档从上往下读就是
 * 执行顺序（出队是 FIFO，见 `queuedDispatchesFor`），别让"最上面的其实最后跑"。
 */
function comparePixieTasks(left: PixieTaskTreeTask, right: PixieTaskTreeTask): number {
  const rank = PIXIE_TASK_RANK[left.status] - PIXIE_TASK_RANK[right.status];
  if (rank !== 0) return rank;
  return left.status === "queued"
    ? left.createdAt - right.createdAt
    : right.createdAt - left.createdAt;
}

function buildTask(record: PixieDispatchRecord): PixieTaskTreeTask {
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
 * 会话落点还在不在：面板的行来自委派记录，记录不随会话删除消失，所以这里先替
 * 前端看一眼磁盘。跳转要用的 sessionPath 也一并按同一次判定给出（归档时给归档
 * 目录里的那份，好让前端说清「去哪恢复」而不是「找不到了」）。
 *
 * 判定只看文件在不在，不解析内容：损坏的文件依旧算 active，交给 session.open
 * 去报真正的错误——这里不该替 Host 猜「能不能打开」。
 */
function sessionLivenessOf(
  agentDir: string,
  cwd: string,
  records: PixieDispatchRecord[],
): { sessionPath: string | null; liveness: PixieSessionLiveness } {
  // 同一条会话的多条记录路径一致（新建后回填的那次）；取最近一条带路径的。
  const located = records.reduce<PixieDispatchRecord | null>(
    (newest, record) =>
      record.sessionPath && (!newest || record.createdAt > newest.createdAt) ? record : newest,
    null,
  );
  const sessionPath = located?.sessionPath ?? null;
  if (!sessionPath) return { sessionPath: null, liveness: "unknown" };
  if (existsSync(sessionPath)) return { sessionPath, liveness: "active" };
  const archivedPath = join(sessionStorageDirs(agentDir, cwd).archiveDir, basename(sessionPath));
  return existsSync(archivedPath)
    ? { sessionPath: archivedPath, liveness: "archived" }
    : { sessionPath, liveness: "missing" };
}

/**
 * 组装任务树。归属过滤沿用委派面板语义（活跃跨段 + 当前段历史），与
 * `pixie.dispatches` 看到的是同一批记录，只是换了投影形状。
 * 排序：工作区 / 会话按最近活动倒序；任务按档位排（见 `comparePixieTasks`）。
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
      const tasks = sessionRecords.map((record) => buildTask(record)).sort(comparePixieTasks);
      const label = sessionId
        ? sessionLabel(sessionRecords) || `会话 ${sessionId.slice(0, 8)}`
        : pixieWorkspaceLabel(cwd);
      const { sessionPath, liveness } = sessionLivenessOf(agentDir, cwd, sessionRecords);
      sessionNodes.push({ sessionId, label, sessionPath, liveness, tasks });
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
