/**
 * 委派面板的任务树：「工作区 → 会话 → 任务」三层。
 *
 * 面板只承载导航与操作，不承载正文：任务行只显示短名 + 四态，详细提示词与
 * 结束内容不进这棵树（要看正文就点行尾的定位按钮，跳到会话里的锚点消息）。
 * 操作入口全部保留：回答 ask、插话（补充/进度检查点）、叫停、重试。
 */
import { useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Crosshair,
  MessageCirclePlus,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import type {
  PixieTaskStatus,
  PixieTaskTreeSession,
  PixieTaskTreeTask,
  PixieTaskTreeWorkspace,
} from "@piabyss/protocol";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { canJumpToPixieTask, jumpToPixieTask } from "./pixie-task-jump";

export type PixieTaskActions = {
  onReply: (dispatchId: string, text: string) => void;
  onInterject: (dispatchId: string, text: string, mode: "append" | "checkpoint") => void;
  onStop: (dispatchId: string) => void;
  onRetry: (dispatchId: string, mode: "resume" | "redispatch") => void;
};

const iconButtonClass =
  "flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground";

/** 四态 → 小色点（与列表卡片的色语义一致：进行中=强调，失败=危险）。 */
function taskDotClass(status: PixieTaskStatus, stale: boolean): string {
  if (status === "done") return "bg-success";
  if (status === "failed") return "bg-danger";
  if (status === "queued") return "bg-warning";
  return stale ? "bg-warning" : "bg-accent";
}

function taskStatusLabel(status: PixieTaskStatus, t: Translate): string {
  if (status === "queued") return t("pixieTaskQueued");
  if (status === "done") return t("pixieTaskDone");
  if (status === "failed") return t("pixieTaskFailed");
  return t("pixieTaskRunning");
}

function taskStatusClass(status: PixieTaskStatus, escalate: boolean): string {
  if (status === "done") return "text-success";
  if (status === "failed") return escalate ? "text-danger font-semibold" : "text-danger";
  return "text-muted";
}

/** 跳转按钮的提示：锚点在哪条消息上，就告诉用户会落到哪里。 */
function jumpTitle(task: PixieTaskTreeTask, t: Translate): string {
  if (!canJumpToPixieTask(task.jump)) return t("pixieTaskJumpUnavailable");
  if (task.jump.anchor === "report") return t("pixieTaskJumpReport");
  if (task.jump.anchor === "dispatch") return t("pixieTaskJumpDispatch");
  return t("pixieTaskJumpNoAnchor");
}

function relativeTime(at: number, t: Translate): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return t("pixieTimeJustNow");
  if (minutes < 60) return t("pixieTimeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("pixieTimeHoursAgo", { count: hours });
  return t("pixieTimeDaysAgo", { count: Math.floor(hours / 24) });
}

/**
 * 任务行：折叠态只有「色点 + 短名 + 四态 + 相对时间 + 定位」；展开态追加操作
 * （回答 / 插话 / 叫停 / 重试）。正文（提示词、结束内容）一概不渲染。
 */
function TaskRow({ task, actions }: { task: PixieTaskTreeTask; actions: PixieTaskActions }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [interjectDraft, setInterjectDraft] = useState("");
  const [interjectOpen, setInterjectOpen] = useState(false);
  const running = task.statusDetail === "dispatched";
  const paused = task.statusDetail === "paused";
  const queued = task.statusDetail === "queued";
  const awaiting = task.statusDetail === "awaiting_user";
  const failed = task.statusDetail === "failed";
  const stopped = task.statusDetail === "stopped";
  const escalate = task.failCount >= 3;
  const at = task.lastActiveAt ?? task.createdAt;
  const live = task.status === "running" || task.status === "queued";

  async function handleJump() {
    await jumpToPixieTask(task.jump);
  }

  return (
    <div
      data-testid="pixie-task-row"
      className={`rounded-md border bg-surface-raised text-xs ${
        task.stale && live ? "border-l-2 border-l-warning border-border" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5 p-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span
            className={`size-1.5 shrink-0 rounded-full ${taskDotClass(task.status, task.stale)}`}
          />
          <span className="min-w-0 flex-1 truncate text-foreground/90">{task.label}</span>
          <span className={`shrink-0 text-[10px] ${taskStatusClass(task.status, escalate)}`}>
            {taskStatusLabel(task.status, t)}
            {escalate ? ` · ${t("pixieEscalateTag", { count: task.failCount })}` : ""}
          </span>
        </button>
        <span className="shrink-0 text-[10px] text-muted" title={new Date(at).toLocaleString()}>
          {relativeTime(at, t)}
        </span>
        <button
          type="button"
          data-testid="pixie-task-jump"
          className={iconButtonClass}
          title={jumpTitle(task, t)}
          aria-label={jumpTitle(task, t)}
          disabled={!canJumpToPixieTask(task.jump)}
          onClick={() => void handleJump()}
        >
          <Crosshair size={13} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border px-2 py-1.5">
          {awaiting && task.question && (
            <div className="mb-1.5 rounded-md border border-primary/30 bg-primary/5 p-2">
              <p className="whitespace-pre-wrap text-foreground">{task.question}</p>
              {task.options.length > 0 && (
                <p className="mt-1 text-[10px] text-muted">{task.options.join(" / ")}</p>
              )}
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  data-testid="pixie-dispatch-reply-input"
                  value={replyDraft}
                  onChange={(event) => setReplyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing &&
                      replyDraft.trim()
                    ) {
                      actions.onReply(task.dispatchId, replyDraft.trim());
                      setReplyDraft("");
                    }
                  }}
                  placeholder={t("pixieReplyPlaceholder")}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none placeholder:text-muted focus:border-primary/50"
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-foreground px-2 py-1 text-xs text-surface disabled:opacity-40"
                  disabled={!replyDraft.trim()}
                  onClick={() => {
                    actions.onReply(task.dispatchId, replyDraft.trim());
                    setReplyDraft("");
                  }}
                >
                  {t("pixieReplySend")}
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {(running || paused || awaiting) && (
              <button
                type="button"
                className={iconButtonClass}
                title={t("pixieInterjectButton")}
                aria-label={t("pixieInterjectButton")}
                onClick={() => {
                  setInterjectOpen((open) => !open);
                  setInterjectDraft("");
                }}
              >
                <MessageCirclePlus size={13} />
              </button>
            )}
            {(running || paused) && (
              <button
                type="button"
                className={iconButtonClass}
                title={t("pixieProgressAskButton")}
                aria-label={t("pixieProgressAskButton")}
                onClick={() =>
                  actions.onInterject(task.dispatchId, t("pixieProgressRequestText"), "checkpoint")
                }
              >
                <Activity size={13} />
              </button>
            )}
            {(running || paused || queued || awaiting) && (
              <button
                type="button"
                data-testid="pixie-dispatch-stop"
                className={`${iconButtonClass} hover:border-danger/50 hover:text-danger`}
                title={t("pixieStopButton")}
                aria-label={t("pixieStopButton")}
                onClick={() => actions.onStop(task.dispatchId)}
              >
                <Square size={12} fill="currentColor" />
              </button>
            )}
            {(failed || stopped) && (
              <>
                <button
                  type="button"
                  data-testid="pixie-dispatch-resume"
                  className={iconButtonClass}
                  title={t("pixieRetryResume")}
                  aria-label={t("pixieRetryResume")}
                  onClick={() => actions.onRetry(task.dispatchId, "resume")}
                >
                  <Play size={13} />
                </button>
                <button
                  type="button"
                  className={iconButtonClass}
                  title={t("pixieRetryRedispatch")}
                  aria-label={t("pixieRetryRedispatch")}
                  onClick={() => actions.onRetry(task.dispatchId, "redispatch")}
                >
                  <RotateCcw size={13} />
                </button>
              </>
            )}
          </div>
          {interjectOpen && (running || paused || awaiting) && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                data-testid="pixie-dispatch-interject-input"
                value={interjectDraft}
                onChange={(event) => setInterjectDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing &&
                    interjectDraft.trim()
                  ) {
                    actions.onInterject(task.dispatchId, interjectDraft.trim(), "append");
                    setInterjectDraft("");
                    setInterjectOpen(false);
                  }
                }}
                placeholder={t("pixieInterjectPlaceholder")}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none placeholder:text-muted focus:border-primary/50"
              />
              <button
                type="button"
                className="shrink-0 rounded-md bg-foreground px-2 py-1 text-xs text-surface disabled:opacity-40"
                disabled={!interjectDraft.trim()}
                onClick={() => {
                  actions.onInterject(task.dispatchId, interjectDraft.trim(), "append");
                  setInterjectDraft("");
                  setInterjectOpen(false);
                }}
              >
                {t("pixieReplySend")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 会话节点：会话名 + 任务数；折叠只影响本会话的任务列表。 */
function SessionNode({
  session,
  actions,
  collapsed,
  onToggle,
}: {
  session: PixieTaskTreeSession;
  actions: PixieTaskActions;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div data-testid="pixie-task-session">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={session.sessionId || undefined}
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
        <span className="min-w-0 flex-1 truncate text-left">{session.label}</span>
        <span className="shrink-0 text-[10px] text-muted">{session.tasks.length}</span>
      </button>
      {!collapsed && (
        <div className="mt-0.5 space-y-1 pl-4">
          {session.tasks.map((task) => (
            <TaskRow key={task.dispatchId} task={task} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 三层树的主体。默认全展开（记录本身有上限，一屏能扫完），工作区/会话行可
 * 单独收起；没有任何委派时给出空态文案。
 */
export function PixieTaskTree({
  groups,
  actions,
}: {
  groups: PixieTaskTreeWorkspace[];
  actions: PixieTaskActions;
}) {
  const t = useT();
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(() => new Set());
  const taskCount = useMemo(
    () =>
      groups.reduce(
        (total, group) =>
          total + group.sessions.reduce((inner, session) => inner + session.tasks.length, 0),
        0,
      ),
    [groups],
  );
  if (taskCount === 0) {
    return <p className="py-6 text-center text-xs text-muted">{t("pixieDispatchEmpty")}</p>;
  }
  const toggleWorkspace = (cwd: string): void =>
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  const toggleSession = (key: string): void =>
    setCollapsedSessions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div data-testid="pixie-task-tree" className="space-y-2">
      {groups.map((group) => {
        const workspaceCollapsed = collapsedWorkspaces.has(group.cwd);
        return (
          <div key={group.cwd} data-testid="pixie-task-workspace">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs font-semibold transition-colors hover:bg-surface-overlay"
              onClick={() => toggleWorkspace(group.cwd)}
              aria-expanded={!workspaceCollapsed}
              title={group.cwd}
            >
              <ChevronDown
                size={12}
                className={`shrink-0 text-muted transition-transform ${
                  workspaceCollapsed ? "-rotate-90" : ""
                }`}
              />
              <span className="min-w-0 flex-1 truncate">{group.workspaceLabel}</span>
              <span className="shrink-0 text-[10px] font-normal text-muted">
                {group.sessions.length}
              </span>
            </button>
            {!workspaceCollapsed && (
              <div className="mt-0.5 space-y-1.5 pl-2">
                {group.sessions.map((session) => {
                  const key = `${group.cwd}\n${session.sessionId}`;
                  return (
                    <SessionNode
                      key={key}
                      session={session}
                      actions={actions}
                      collapsed={collapsedSessions.has(key)}
                      onToggle={() => toggleSession(key)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
