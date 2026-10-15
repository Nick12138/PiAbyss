/**
 * 委派面板：一行一个「工作区 · 会话」，下面挂它的任务。
 *
 * 面板只做导航。任务行只有「色点 + 短名 + 四态 + 相对时间」，正文（提示词、结束
 * 内容）与一切操作都不在这里；跳转按**会话**给——行尾那个按钮打开这一行对应的会
 * 话，不再定位到某条消息。要插话、要叫停、要回答 ask，跳进会话对着说就是了。操作
 * 能力本身一个没删，只是入口归小精灵（控制面上的 interject / stop / retry），用户
 * 不该在这块 30% 宽的侧栏里再要一套。
 */
import { useMemo, useState } from "react";
import { ChevronRight, Crosshair } from "lucide-react";
import type {
  PixieSessionLiveness,
  PixieTaskTreeTask,
  PixieTaskTreeWorkspace,
} from "@piabyss/protocol";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { jumpToPixieSession, type PixieSessionTarget } from "./pixie-session-jump";

const iconButtonClass =
  "flex size-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-overlay hover:text-foreground";

/** 四态 → 小色点（与列表卡片的色语义一致：进行中=强调，失败=危险）。 */
function taskDotClass(task: PixieTaskTreeTask): string {
  if (isAwaiting(task)) return "bg-warning";
  if (task.status === "done") return "bg-success";
  if (task.status === "failed") return "bg-danger";
  if (task.status === "queued") return "bg-warning";
  return task.stale ? "bg-warning" : "bg-accent";
}

/** 等用户答复是「进行中」里的一个特例：四态不带这个信息，面板单独说。 */
function isAwaiting(task: PixieTaskTreeTask): boolean {
  return task.statusDetail === "awaiting_user";
}

function taskStatusLabel(task: PixieTaskTreeTask, t: Translate): string {
  if (isAwaiting(task)) return t("pixieTaskAwaiting");
  if (task.status === "queued") return t("pixieTaskQueued");
  if (task.status === "done") return t("pixieTaskDone");
  if (task.status === "failed") return t("pixieTaskFailed");
  return t("pixieTaskRunning");
}

function taskStatusClass(task: PixieTaskTreeTask, escalate: boolean): string {
  if (isAwaiting(task)) return "text-warning font-medium";
  if (task.status === "done") return "text-success";
  if (task.status === "failed") return escalate ? "text-danger font-semibold" : "text-danger";
  return "text-muted";
}

function relativeTime(at: number, t: Translate): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return t("pixieTimeJustNow");
  if (minutes < 60) return t("pixieTimeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("pixieTimeHoursAgo", { count: hours });
  return t("pixieTimeDaysAgo", { count: Math.floor(hours / 24) });
}

function TaskRow({ task }: { task: PixieTaskTreeTask }) {
  const t = useT();
  const escalate = task.failCount >= 3;
  const at = task.lastActiveAt ?? task.createdAt;
  const live = task.status === "running" || task.status === "queued";

  return (
    <div
      data-testid="pixie-task-row"
      className={`rounded-md border bg-surface-raised text-xs ${
        task.stale && live ? "border-l-2 border-l-warning border-border" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span className={`size-1.5 shrink-0 rounded-full ${taskDotClass(task)}`} />
        <span className="min-w-0 flex-1 truncate text-foreground/90">{task.label}</span>
        <span className={`shrink-0 text-[10px] ${taskStatusClass(task, escalate)}`}>
          {taskStatusLabel(task, t)}
          {escalate ? ` · ${t("pixieEscalateTag", { count: task.failCount })}` : ""}
        </span>
        <span className="shrink-0 text-[10px] text-muted" title={new Date(at).toLocaleString()}>
          {relativeTime(at, t)}
        </span>
      </div>
    </div>
  );
}

/** 面板的一行：合成后的分组标题、它的跳转目标（未落点为 null）与它的任务。 */
type GroupLine = {
  key: string;
  label: string;
  jump: PixieSessionTarget | null;
  /** 会话落点的存活状态：没了 / 归档的行直接在面板上点出来，不用点一次才知道。 */
  liveness: PixieSessionLiveness;
  tasks: PixieTaskTreeTask[];
};

/**
 * 落点已不在时的行内标记：会话被删（记录还在）与已归档是两件事，前者没救、
 * 后者能恢复，所以分开说；`active` / `unknown` 不标记（后者只是记录里没路径，
 * 不是「没了」）。
 */
function goneTag(liveness: PixieSessionLiveness, t: Translate): string | null {
  if (liveness === "missing") return t("pixieSessionMissingTag");
  if (liveness === "archived") return t("pixieSessionArchivedTag");
  return null;
}

/**
 * Host 的投影是「工作区 → 会话 → 任务」三层，面板只铺两层：工作区名并进会话行当
 * 前缀。跳转按会话给，坐标就是这一行的工作区 + 会话，不定位到某条消息。未落点的
 * 记录（受理前就失败）挂在没有会话 id 的节点上、标签本身就是工作区名，这时前缀会
 * 重复，只留工作区名，也没有可跳的会话。
 */
function toGroupLines(groups: PixieTaskTreeWorkspace[]): GroupLine[] {
  const lines: GroupLine[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      const bare = !session.sessionId || session.label === group.workspaceLabel;
      lines.push({
        key: `${group.cwd}\n${session.sessionId}`,
        label: bare ? group.workspaceLabel : `${group.workspaceLabel} · ${session.label}`,
        jump: session.sessionId
          ? {
              cwd: group.cwd,
              sessionId: session.sessionId,
              sessionPath: session.sessionPath,
              liveness: session.liveness,
            }
          : null,
        liveness: session.liveness,
        tasks: session.tasks,
      });
    }
  }
  return lines;
}

/**
 * 两层树的主体。默认全展开（记录本身有上限，一屏能扫完），分组行可单独收起；行的
 * 先后沿用 Host 的最近活动倒序。没有任何委派时给出空态文案。
 */
export function PixieTaskTree({ groups }: { groups: PixieTaskTreeWorkspace[] }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const lines = useMemo(() => toGroupLines(groups), [groups]);
  const taskCount = useMemo(
    () => lines.reduce((total, line) => total + line.tasks.length, 0),
    [lines],
  );
  if (taskCount === 0) {
    return <p className="py-6 text-center text-xs text-muted">{t("pixieDispatchEmpty")}</p>;
  }
  const toggle = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div data-testid="pixie-task-tree" className="space-y-1.5">
      {lines.map((line) => {
        const isCollapsed = collapsed.has(line.key);
        const jump = line.jump;
        const tag = jump ? goneTag(line.liveness, t) : null;
        return (
          <div key={line.key} data-testid="pixie-task-group">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
                onClick={() => toggle(line.key)}
                aria-expanded={!isCollapsed}
                title={line.label}
              >
                <ChevronRight
                  size={11}
                  className={`shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                />
                <span className="min-w-0 flex-1 truncate text-left">{line.label}</span>
                {/* 落点已不在（删除 / 归档）：不用点一次才知道——面板上就写清楚，
                 * 点击时也只会就地提示，不再把用户送去一个打不开的页面。 */}
                {tag && (
                  <span
                    data-testid="pixie-session-gone-tag"
                    className="shrink-0 text-[10px] text-warning"
                    title={
                      line.liveness === "missing"
                        ? t("pixieSessionGone")
                        : t("pixieSessionArchived")
                    }
                  >
                    {tag}
                  </span>
                )}
                {/* 计数与标签同号（11px），次级感靠 400 字重 + muted 给；tabular-nums 让位数
                 * 从 1 变到 10 时行宽不跳。此前这里是 text-[10px]，比同一行的 11px 标签小一
                 * 档，数字墨迹只有汉字的三分之二高，看着"没居中"（几何上其实居中）。 */}
                <span className="shrink-0 font-normal text-muted tabular-nums">
                  {line.tasks.length}
                </span>
              </button>
              {jump && (
                <button
                  type="button"
                  data-testid="pixie-session-jump"
                  className={iconButtonClass}
                  title={t("pixieSessionJumpButton")}
                  aria-label={t("pixieSessionJumpButton")}
                  onClick={() => void jumpToPixieSession(jump)}
                >
                  {/* 与行内 chevron、正文同为 11px（PixieBackToCurrentButton 也是 text-[11px]+
                   * size={11} 这套）；之前是 12px，比同一行的文字大一号，看着比文字"高"。 */}
                  <Crosshair size={11} />
                </button>
              )}
            </div>
            {!isCollapsed && (
              <div className="mt-0.5 space-y-1 pl-2">
                {line.tasks.map((task) => (
                  <TaskRow key={task.dispatchId} task={task} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
