/**
 * Pixie (小精灵) conversation page — v5 标准通道化主题视图。
 *
 * 小精灵当前会话就是 `<agentDir>/workspace/pixie` 工作区里的标准会话：挂载时
 * `pixie.ensureCurrent` 拿到锚点后走 `openSessionAcrossWorkspaces`（内部完成
 * workspace.setCurrent + session.open），此后转写/输入框/统计全部由标准
 * session.snapshot / agent.event 推送驱动——与普通会话同一套机制，仅展示不同：
 *   - 顶部动作（打个盹 / 会话列表弹窗）在 AppTopBar；
 *   - 右侧保留委派面板（pixie.dispatches 轮询 + 回复/插话/叫停/重试）；
 *   - ask 待回复时把输入框发送改道 pixie.reply；
 *   - 内嵌扩展 UI（ask_user_question 问卷等）与子代理对话视图对齐 ChatPage
 *     的挂载方式——小精灵会话是标准会话，两类工具的交互面必须同样可用。
 * 卸载时恢复进入前的工作区（除非用户已手动跳走），并丢弃子代理视图状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageCirclePlus,
  Play,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import type { PixieDispatchRecord } from "@piabyss/protocol";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activateWorkspaceAcrossWorkspaces,
  openSessionAcrossWorkspaces,
} from "../../lib/bridge/session-navigation";
import { Transcript } from "../chat/Transcript";
import { Composer } from "../chat/Composer";
import { SessionStatsPills } from "../chat/StatsPills";
import { InlineExtensionUiRequest } from "../chat/InlineExtensionUiRequest";
import { SubagentConversation } from "../subagents/SubagentConversation";
import {
  ComposerRuntimeProvider,
  useComposerRuntime,
  type ComposerRuntime,
} from "../chat/composer-runtime";
import { usePixieViewStore } from "./pixie-store";
import { isSamePixiePath } from "../../lib/pixie-path";

const DISPATCH_POLL_IDLE_MS = 5_000;
const DISPATCH_POLL_ACTIVE_MS = 2_000;

/** 还没走到终态的记录（活跃区）；终态的进历史折叠区。 */
function isLiveDispatch(record: PixieDispatchRecord): boolean {
  return (
    record.status === "dispatched" ||
    record.status === "queued" ||
    record.status === "paused" ||
    record.status === "awaiting_user"
  );
}

/** 面板相对时间（绝对时间放 title 悬浮）。 */
function relativeTime(at: number, t: Translate): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return t("pixieTimeJustNow");
  if (minutes < 60) return t("pixieTimeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("pixieTimeHoursAgo", { count: hours });
  return t("pixieTimeDaysAgo", { count: Math.floor(hours / 24) });
}

/** 状态 → 小色点（活跃卡与历史行共用一套颜色语义）。 */
function dispatchDotClass(record: PixieDispatchRecord): string {
  if (record.status === "awaiting_user") return "bg-primary";
  if (record.status === "failed" || (record.status === "reported" && record.kind === "error"))
    return "bg-danger";
  if (record.status === "reported") return "bg-success";
  if (record.status === "stopped" || record.status === "cancelled") return "bg-muted";
  if (record.status === "queued" || record.status === "paused") return "bg-warning";
  return record.stale ? "bg-warning" : "bg-accent";
}

type DispatchActions = {
  onReply: (dispatchId: string, text: string) => void;
  onInterject: (dispatchId: string, text: string, mode: "append" | "checkpoint") => void;
  onStop: (dispatchId: string) => void;
  onRetry: (dispatchId: string, mode: "resume" | "redispatch") => void;
};

const iconButtonClass =
  "flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground";

/**
 * 瘦身后的委派卡片：状态色点 + 相对时间的头部、单行可展开的任务文本、
 * chips 行（模型/批次/进度/文件）、ask 内联回复框、icon 化动作行。
 * 活跃区直接用；历史行展开时也复用它作为详情。
 */
function DispatchRow({
  record,
  actions,
  startExpanded = false,
}: {
  record: PixieDispatchRecord;
  actions: DispatchActions;
  /** 历史详情复用时默认展开全文。 */
  startExpanded?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(startExpanded);
  const [replyDraft, setReplyDraft] = useState("");
  const [interjectOpen, setInterjectOpen] = useState(false);
  const [interjectDraft, setInterjectDraft] = useState("");
  const awaiting = record.status === "awaiting_user";
  const running = record.status === "dispatched";
  const queued = record.status === "queued";
  const paused = record.status === "paused";
  const failed =
    record.status === "failed" || (record.status === "reported" && record.kind === "error");
  const stopped = record.status === "stopped";
  const retriable = failed || stopped;
  const escalate = record.failCount >= 3;
  const statusLabel = awaiting
    ? t("pixieKindAsk")
    : running
      ? record.stale
        ? t("pixieKindStale")
        : t("pixieKindRunning")
      : queued
        ? t("pixieKindQueued")
        : paused
          ? t("pixieKindPaused")
          : record.status === "reported"
            ? record.kind === "error"
              ? t("pixieKindError")
              : t("pixieKindDone")
            : record.status === "failed"
              ? t("pixieKindError")
              : stopped
                ? t("pixieKindStopped")
                : record.status === "cancelled"
                  ? t("pixieKindCancelled")
                  : t("pixieKindError");
  const statusClass = awaiting
    ? "text-primary"
    : record.status === "reported" && record.kind !== "error"
      ? "text-success"
      : failed
        ? escalate
          ? "text-danger font-semibold"
          : "text-danger"
        : stopped || record.status === "cancelled"
          ? "text-muted"
          : record.stale
            ? "text-warning"
            : "text-muted";
  const at = record.lastActiveAt ?? record.createdAt;
  const liveStale = record.stale && isLiveDispatch(record);
  return (
    <div
      data-testid="pixie-dispatch-card"
      className={`rounded-md border bg-surface-raised p-2.5 text-xs ${
        liveStale ? "border-l-2 border-l-warning border-border" : "border-border"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${dispatchDotClass(record)}`} />
        <span className={`min-w-0 truncate font-medium ${statusClass}`}>
          {statusLabel}
          {escalate ? ` · ${t("pixieEscalateTag", { count: record.failCount })}` : ""}
        </span>
        <span
          className="ml-auto shrink-0 text-[10px] text-muted"
          title={new Date(at).toLocaleString()}
        >
          {relativeTime(at, t)}
        </span>
      </div>
      <button
        type="button"
        className="w-full rounded text-left"
        onClick={() => setExpanded((value) => !value)}
        title={record.task}
      >
        <p className={`text-foreground/90 ${expanded ? "whitespace-pre-wrap" : "line-clamp-1"}`}>
          {record.task}
        </p>
      </button>
      {record.progressSummary && (
        <p className="mt-1 line-clamp-2 text-[10px] text-muted">📈 {record.progressSummary}</p>
      )}
      {(record.model || record.batchId || record.files?.length) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted">
          {record.model && (
            <span
              className="rounded bg-surface-overlay px-1 py-px"
              title={record.thinkingLevel ?? ""}
            >
              🤖 {record.model}
              {record.thinkingLevel && ` (${record.thinkingLevel})`}
            </span>
          )}
          {record.batchId && (
            <span className="rounded bg-surface-overlay px-1 py-px">{record.batchId}</span>
          )}
          {record.files && record.files.length > 0 && (
            <span className="rounded bg-surface-overlay px-1 py-px" title={record.files.join("\n")}>
              📄 {record.files.length} {t("pixieFilesCount")}
            </span>
          )}
        </div>
      )}
      {awaiting && record.question && (
        <div className="mt-1.5 rounded-md border border-primary/30 bg-primary/5 p-2">
          <p className="whitespace-pre-wrap text-foreground">{record.question}</p>
          {record.options.length > 0 && (
            <p className="mt-1 text-[10px] text-muted">{record.options.join(" / ")}</p>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              data-testid="pixie-dispatch-reply-input"
              value={replyDraft}
              onChange={(event) => setReplyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && replyDraft.trim()) {
                  actions.onReply(record.id, replyDraft.trim());
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
                actions.onReply(record.id, replyDraft.trim());
                setReplyDraft("");
              }}
            >
              {t("pixieReplySend")}
            </button>
          </div>
        </div>
      )}
      {!awaiting && record.report && expanded && (
        <p className="mt-1.5 whitespace-pre-wrap border-t border-border pt-1.5 text-muted">
          {record.report}
        </p>
      )}
      {/* 动作行（icon 化）：ask 内联回复承担答复入口，主输入框在 ask 期间也
       * 自动改道 pixie.reply——两处任选其一，顶部横幅已省。 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {(running || awaiting) && (
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
        {running && (
          <button
            type="button"
            className={iconButtonClass}
            title={t("pixieProgressAskButton")}
            aria-label={t("pixieProgressAskButton")}
            onClick={() =>
              actions.onInterject(record.id, t("pixieProgressRequestText"), "checkpoint")
            }
          >
            <Activity size={13} />
          </button>
        )}
        {(running || queued || awaiting) && (
          <button
            type="button"
            data-testid="pixie-dispatch-stop"
            className={`${iconButtonClass} hover:border-danger/50 hover:text-danger`}
            title={t("pixieStopButton")}
            aria-label={t("pixieStopButton")}
            onClick={() => actions.onStop(record.id)}
          >
            <Square size={12} fill="currentColor" />
          </button>
        )}
        {retriable && (
          <>
            <button
              type="button"
              data-testid="pixie-dispatch-resume"
              className={iconButtonClass}
              title={t("pixieRetryResume")}
              aria-label={t("pixieRetryResume")}
              onClick={() => actions.onRetry(record.id, "resume")}
            >
              <Play size={13} />
            </button>
            <button
              type="button"
              className={iconButtonClass}
              title={t("pixieRetryRedispatch")}
              aria-label={t("pixieRetryRedispatch")}
              onClick={() => actions.onRetry(record.id, "redispatch")}
            >
              <RotateCcw size={13} />
            </button>
          </>
        )}
      </div>
      {interjectOpen && (running || awaiting) && (
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
                actions.onInterject(record.id, interjectDraft.trim(), "append");
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
              actions.onInterject(record.id, interjectDraft.trim(), "append");
              setInterjectDraft("");
              setInterjectOpen(false);
            }}
          >
            {t("pixieReplySend")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 历史折叠区的紧凑行：色点 + 单行任务 + 相对时间；点击展开成完整卡片
 * （失败摘录、retry 动作都在展开里）。
 */
function DispatchHistoryRow({
  record,
  expanded,
  onToggle,
  actions,
}: {
  record: PixieDispatchRecord;
  expanded: boolean;
  onToggle: () => void;
  actions: DispatchActions;
}) {
  const t = useT();
  const at = record.reportedAt ?? record.createdAt;
  return (
    <div data-testid="pixie-dispatch-history-row">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-xs transition-colors hover:bg-surface-overlay"
        onClick={onToggle}
        title={record.task}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className={`size-1.5 shrink-0 rounded-full ${dispatchDotClass(record)}`} />
        <span className="min-w-0 flex-1 truncate text-left text-foreground/90">{record.task}</span>
        <span className="shrink-0 text-[10px] text-muted" title={new Date(at).toLocaleString()}>
          {relativeTime(at, t)}
        </span>
      </button>
      {expanded && (
        <div className="mt-1">
          <DispatchRow record={record} actions={actions} startExpanded />
        </div>
      )}
    </div>
  );
}

export function PixiePage() {
  const t = useT();
  // 依赖 host 的“实例标识”而不是 host 对象：会话切换（session.open）会
  // 更新 host 的 sessionId/sessionRevision 身份字段并产生新对象引用，若
  // effect 依赖 host 对象，用户在小精灵页里手动切换会话会被 mount-acquire
  // 立即拉回锚点会话（“切换无效”）。hostInstanceId 只在宿主实例真正变化
  // （首次就绪 / 宿主重启）时改变。
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? []);
  const activeSubagentNodeId = useAppStore((s) => s.activeSubagentNodeId);
  const current = usePixieViewStore((s) => s.current);
  const dispatches = usePixieViewStore((s) => s.dispatches);
  const error = usePixieViewStore((s) => s.error);
  const refreshDispatches = usePixieViewStore((s) => s.refreshDispatches);
  const reply = usePixieViewStore((s) => s.reply);
  const pushContext = usePixieViewStore((s) => s.pushContext);
  const interject = usePixieViewStore((s) => s.interject);
  const stopDispatch = usePixieViewStore((s) => s.stopDispatch);
  const retryDispatch = usePixieViewStore((s) => s.retryDispatch);

  const [acquiring, setAcquiring] = useState(true);
  const [acquireFailed, setAcquireFailed] = useState(false);
  /** 进入 pixie 页前的工作区 cwd；null = 之前没有活动工作区（卸载时不恢复）。 */
  const prevCwdRef = useRef<string | null>(null);

  /**
   * 锚点获取 + 会话打开。幂等：会话已激活时 openSessionAcrossWorkspaces 快速
   * 返回 already-active；segmentChanged 事件（打盹切新会话）触发重跑即可。
   */
  const acquire = useCallback(async () => {
    const pixie = await usePixieViewStore.getState().ensureCurrent();
    if (!pixie) {
      setAcquireFailed(true);
      return;
    }
    setAcquireFailed(false);
    const outcome = await openSessionAcrossWorkspaces({
      cwd: pixie.cwd,
      sessionId: pixie.sessionId,
      sessionPath: pixie.sessionPath,
      // 阻塞式切换：切完立刻 session.open，绝不能吃 optimistic 的 pending
      // shell——shell 期 servicesReady=false，session.open 直接 AGENT_NOT_READY
      // （该错误码前端不重试），就是「每次进小精灵页都提示暂不可用、手动
      // 重试才好」的根因之一。等待期间本页本来就有加载态。
      optimistic: false,
      quiet: true,
    });
    if (outcome.status === "opened" || outcome.status === "already-active") {
      setAcquiring(false);
    } else {
      setAcquireFailed(true);
    }
  }, []);

  // Known-workspace push: on mount and whenever the list changes.
  useEffect(() => {
    void pushContext(knownWorkspaces);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push on identity change of the list
  }, [knownWorkspaces]);

  // Mount acquisition (re-run if the Host wasn't ready at first mount, or when
  // the Host instance is replaced). Same-instance session switches (the user
  // picking a session in the sessions dialog) must NOT re-run this — they
  // would yank the transcript back to the anchor session.
  useEffect(() => {
    if (!hostInstanceId) return;
    if (prevCwdRef.current === null) {
      // 记录进入前的工作区；已是 pixie 工作区（如冷启动直落 pixie 页）则不恢复。
      const before = useAppStore.getState().workspace?.canonicalCwd ?? null;
      const pixieCwd = usePixieViewStore.getState().current?.cwd;
      prevCwdRef.current = before && !isSamePixiePath(before, pixieCwd) ? before : null;
    }
    void acquire();
  }, [hostInstanceId, acquire]);

  // Leaving the pixie page: hand the active workspace back so the chat page
  // keeps showing whatever the user had before. Skipped when the user already
  // navigated elsewhere themselves.
  useEffect(() => {
    return () => {
      // 子代理视图是全局 store 状态：离开 pixie 页时丢弃，避免把小精灵会话
      // 的子代理对话残留到 chat 页（那边有自己的 SubagentConversation 与
      // 面包屑，语境完全不同）。
      if (useAppStore.getState().activeSubagentNodeId) {
        useAppStore.getState().setActiveSubagent(null);
      }
      const pixieCwd = usePixieViewStore.getState().current?.cwd;
      const before = prevCwdRef.current;
      if (!before || !pixieCwd) return;
      if (!isSamePixiePath(useAppStore.getState().workspace?.canonicalCwd, pixieCwd)) return;
      void activateWorkspaceAcrossWorkspaces(before, { quiet: true });
    };
  }, []);

  // Callback/ask/stale events refresh the dispatch panel.
  useEffect(() => {
    if (!hostInstanceId) return;
    return hostClient.onEvent((event) => {
      if (
        event.event === "pixie.reportReceived" ||
        event.event === "pixie.askReceived" ||
        event.event === "pixie.staleWarning"
      ) {
        void refreshDispatches();
      }
    });
  }, [hostInstanceId, refreshDispatches]);

  useEffect(() => {
    if (!hostInstanceId) return;
    return hostClient.onEvent((event) => {
      if (event.event === "pixie.segmentChanged") void acquire();
    });
  }, [hostInstanceId, acquire]);

  /**
   * 面板归属会话 = 用户当前打开的那个小精灵会话（会话弹窗里切换后立即跟随）。
   * 会话还没打开时退回锚点。注意不能直接用锚点：用户在弹窗里翻历史会话时
   * 锚点不变，那样面板会一直显示旧会话的委派。
   */
  const panelSessionId = session?.sessionId ?? current?.sessionId ?? null;

  // Dispatch polling: fast while anything is live, slow otherwise. 切会话
  // （panelSessionId 变化）时 effect 重跑，面板立即改为新会话的关联委派。
  const hasActiveDispatch = useMemo(() => dispatches.some(isLiveDispatch), [dispatches]);
  useEffect(() => {
    if (!hostInstanceId) return;
    void refreshDispatches(panelSessionId);
    const timer = setInterval(
      () => void refreshDispatches(),
      hasActiveDispatch ? DISPATCH_POLL_ACTIVE_MS : DISPATCH_POLL_IDLE_MS,
    );
    return () => clearInterval(timer);
  }, [hostInstanceId, panelSessionId, hasActiveDispatch, refreshDispatches]);

  const awaitingDispatch = useMemo(
    () => dispatches.find((d) => d.status === "awaiting_user") ?? null,
    [dispatches],
  );

  // 面板分层：活跃（live）详细卡置顶；终态记录进历史折叠区。
  const activeDispatchRecords = useMemo(() => dispatches.filter(isLiveDispatch), [dispatches]);
  const historyDispatchRecords = useMemo(
    () => dispatches.filter((d) => !isLiveDispatch(d)),
    [dispatches],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  function handleReplyInline(dispatchId: string, text: string) {
    if (!text) return;
    void reply(dispatchId, text);
  }

  function handleInterject(dispatchId: string, text: string, mode: "append" | "checkpoint") {
    if (!text) return;
    void interject(dispatchId, text, mode, mode === "checkpoint" ? "continue" : undefined);
  }

  function handleStop(dispatchId: string) {
    void stopDispatch(dispatchId);
  }

  function handleRetry(dispatchId: string, mode: "resume" | "redispatch") {
    void retryDispatch(dispatchId, mode);
  }

  const dispatchActions: DispatchActions = {
    onReply: handleReplyInline,
    onInterject: handleInterject,
    onStop: handleStop,
    onRetry: handleRetry,
  };

  /**
   * 输入框运行时：默认实现（读 app store → agent.prompt/steer）。唯一覆写：
   * 有 ask 待回复时，发送改道 pixie.reply（与 v4 的 reply-mode 行为一致）。
   */
  const baseRuntime = useComposerRuntime();
  const runtime = useMemo<ComposerRuntime>(() => {
    if (!awaitingDispatch) return baseRuntime;
    return {
      ...baseRuntime,
      send: async ({ text }) => {
        const ok = await usePixieViewStore.getState().reply(awaitingDispatch.id, text);
        return ok
          ? { ok: true }
          : { ok: false, error: usePixieViewStore.getState().error ?? "reply failed" };
      },
    };
  }, [baseRuntime, awaitingDispatch]);

  // 标准会话视图的就绪条件：锚点拿到且活动工作区确实是 pixie 工作区。
  const ready =
    !acquiring &&
    !acquireFailed &&
    current !== null &&
    isSamePixiePath(workspace?.canonicalCwd, current.cwd) &&
    session !== null;

  if (acquireFailed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Sparkles size={20} className="text-primary" />
        <p className="text-sm text-danger">{error ?? t("pixieUnavailable")}</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-overlay"
          onClick={() => {
            setAcquiring(true);
            setAcquireFailed(false);
            void acquire();
          }}
        >
          {t("pixieRetryAcquire")}
        </button>
      </div>
    );
  }

  if (acquiring || !ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const isNewConversation = Boolean(session && session.messages.length === 0 && session.isIdle);

  return (
    <div className="@container flex h-full min-w-0 flex-col" data-pixie-page>
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        {/* Conversation (70%) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:flex-[7]">
          {activeSubagentNodeId ? (
            /* Subagent view takeover，与 ChatPage 同款：整块对话区属于选中
             * run（自带转写与 composer），主会话转写/输入框仍挂在 store
             * 后面；顶栏面包屑（AppTopBar pixie 分支）负责返回主会话。 */
            <SubagentConversation />
          ) : (
            <>
              {isNewConversation ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                  <Sparkles size={20} className="text-primary" />
                  <p className="text-sm font-medium">{t("pixieEmptyTitle")}</p>
                  <p className="max-w-sm text-xs text-muted">{t("pixieEmptyHint")}</p>
                </div>
              ) : (
                <Transcript />
              )}
              {/* 内嵌扩展 UI（ask_user_question 问卷等）：不挂它时提问请求
               * 照样会进 store 并把 Composer 锁进 decisionBlocked，用户却
               * 看不到问题卡片——死等到超时。与 ChatPage 同位（内容与输入框
               * 之间）。 */}
              <InlineExtensionUiRequest />
              <div className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
                {error && <p className="mb-2 text-xs text-danger">{error}</p>}
                <ComposerRuntimeProvider runtime={runtime}>
                  <Composer inputTestId="pixie-input" />
                  <SessionStatsPills />
                </ComposerRuntimeProvider>
              </div>
            </>
          )}
        </div>

        {/* Delegation panel (30%)：活跃详细卡置顶 + 历史折叠区。 */}
        <div className="hidden min-h-0 flex-col border-l border-border @3xl:flex @3xl:w-[30%]">
          <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted">
            {t("pixieDispatchPanelTitle")}
          </div>
          <div className="scrollbar-subtle min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {activeDispatchRecords.map((record) => (
              <DispatchRow key={record.id} record={record} actions={dispatchActions} />
            ))}
            {historyDispatchRecords.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  data-testid="pixie-history-toggle"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <ChevronDown
                    size={12}
                    className={`shrink-0 transition-transform ${historyOpen ? "" : "-rotate-90"}`}
                  />
                  {t("pixieHistoryCount", { count: historyDispatchRecords.length })}
                </button>
                {historyOpen && (
                  <div className="mt-1 space-y-0.5">
                    {historyDispatchRecords.map((record) => (
                      <DispatchHistoryRow
                        key={record.id}
                        record={record}
                        expanded={expandedHistoryId === record.id}
                        onToggle={() =>
                          setExpandedHistoryId((current) =>
                            current === record.id ? null : record.id,
                          )
                        }
                        actions={dispatchActions}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            {activeDispatchRecords.length === 0 && historyDispatchRecords.length === 0 && (
              <p className="py-6 text-center text-xs text-muted">{t("pixieDispatchEmpty")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
