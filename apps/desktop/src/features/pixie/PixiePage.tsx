/**
 * Pixie (小精灵) conversation page — v5 标准通道化主题视图。
 *
 * 小精灵当前会话就是 `<agentDir>/workspace/pixie` 工作区里的标准会话：挂载时
 * `pixie.ensureCurrent` 拿到锚点后走 `openSessionAcrossWorkspaces`（内部完成
 * workspace.setCurrent + session.open），此后转写/输入框/统计全部由标准
 * session.snapshot / agent.event 推送驱动——与普通会话同一套机制，仅展示不同：
 *   - 顶部动作（打个盹）在 AppTopBar；
 *   - 会话列表收进按钮 + 弹窗（Sidebar）；
 *   - 右侧保留委派面板（pixie.dispatches 轮询 + 回复/插话/叫停/重试）；
 *   - ask 待回复时把输入框发送改道 pixie.reply。
 * 卸载时恢复进入前的工作区（除非用户已手动跳走）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { PixieDispatchRecord } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activateWorkspaceAcrossWorkspaces,
  openSessionAcrossWorkspaces,
} from "../../lib/bridge/session-navigation";
import { Transcript } from "../chat/Transcript";
import { Composer } from "../chat/Composer";
import { SessionStatsPills } from "../chat/StatsPills";
import {
  ComposerRuntimeProvider,
  useComposerRuntime,
  type ComposerRuntime,
} from "../chat/composer-runtime";
import { usePixieViewStore } from "./pixie-store";

const DISPATCH_POLL_IDLE_MS = 5_000;
const DISPATCH_POLL_ACTIVE_MS = 2_000;

/**
 * One delegation row in the right-hand panel: status badge (状态机), progress
 * summary, artifacts, batch tag, escalation marker, and the action row —
 * inline reply (ask), interject (running), stop, resume/redispatch.
 */
function DispatchRow({
  record,
  onReply,
  onInterject,
  onStop,
  onRetry,
}: {
  record: PixieDispatchRecord;
  onReply: (dispatchId: string, text: string) => void;
  onInterject: (dispatchId: string, text: string, mode: "append" | "checkpoint") => void;
  onStop: (dispatchId: string) => void;
  onRetry: (dispatchId: string, mode: "resume" | "redispatch") => void;
}) {
  const t = useT();
  const [replyDraft, setReplyDraft] = useState("");
  const [interjectOpen, setInterjectOpen] = useState(false);
  const [interjectDraft, setInterjectDraft] = useState("");
  const awaiting = record.status === "awaiting_user";
  const running = record.status === "dispatched";
  const queued = record.status === "queued";
  const paused = record.status === "paused";
  const failed = record.status === "failed" || (record.status === "reported" && record.kind === "error");
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
  const statusIcon = awaiting
    ? "❓"
    : record.status === "reported"
      ? record.kind === "error"
        ? "❌"
        : "✅"
      : record.status === "failed"
        ? "❌"
        : record.status === "stopped"
          ? "🛑"
          : record.status === "cancelled"
            ? "🚫"
            : queued
              ? "⏸"
              : paused
                ? "⏸"
                : "⏳";
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
  return (
    <div className="rounded-md border border-border bg-surface-raised p-2.5 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={`font-medium ${statusClass}`}>
          {statusIcon} {statusLabel}
          {escalate ? ` · ${t("pixieEscalateTag", { count: record.failCount })}` : ""}
        </span>
        <span className="text-[10px] text-muted" title={t("pixieLastActiveTitle")}>
          {new Date(record.createdAt).toLocaleTimeString()}
          {record.lastActiveAt && record.lastActiveAt - record.createdAt > 60_000
            ? ` → ${new Date(record.lastActiveAt).toLocaleTimeString()}`
            : ""}
        </span>
      </div>
      <p className="line-clamp-3 text-foreground/90">{record.task}</p>
      {(record.batchId || record.model || record.files?.length || record.progressSummary) && (
        <div className="mt-1 space-y-0.5 text-[10px] text-muted">
          {record.model && (
            <p>
              🤖 <span className="rounded bg-surface-overlay px-1 py-px">{record.model}</span>
              {record.thinkingLevel && <span className="ml-1">({record.thinkingLevel})</span>}
            </p>
          )}
          {record.batchId && (
            <p>
              <span className="rounded bg-surface-overlay px-1 py-px">{record.batchId}</span>
            </p>
          )}
          {record.progressSummary && <p>📈 {record.progressSummary}</p>}
          {record.files && record.files.length > 0 && (
            <p className="truncate" title={record.files.join("\n")}>
              📄 {record.files.length} {t("pixieFilesCount")}
            </p>
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
                  onReply(record.id, replyDraft.trim());
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
                onReply(record.id, replyDraft.trim());
                setReplyDraft("");
              }}
            >
              {t("pixieReplySend")}
            </button>
          </div>
        </div>
      )}
      {!awaiting && record.report && (
        <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap border-t border-border pt-1.5 text-muted">
          {record.report}
        </p>
      )}
      {/* action row */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {(running || awaiting) && (
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-foreground"
            onClick={() => {
              setInterjectOpen((open) => !open);
              setInterjectDraft("");
            }}
          >
            💬 {t("pixieInterjectButton")}
          </button>
        )}
        {running && (
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-foreground"
            onClick={() => onInterject(record.id, t("pixieProgressRequestText"), "checkpoint")}
          >
            📈 {t("pixieProgressAskButton")}
          </button>
        )}
        {(running || queued || awaiting) && (
          <button
            type="button"
            data-testid="pixie-dispatch-stop"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
            onClick={() => onStop(record.id)}
          >
            🛑 {t("pixieStopButton")}
          </button>
        )}
        {retriable && (
          <>
            <button
              type="button"
              data-testid="pixie-dispatch-resume"
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-foreground"
              onClick={() => onRetry(record.id, "resume")}
            >
              ▶ {t("pixieRetryResume")}
            </button>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-foreground"
              onClick={() => onRetry(record.id, "redispatch")}
            >
              ↻ {t("pixieRetryRedispatch")}
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
              if (event.key === "Enter" && !event.nativeEvent.isComposing && interjectDraft.trim()) {
                onInterject(record.id, interjectDraft.trim(), "append");
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
              onInterject(record.id, interjectDraft.trim(), "append");
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

export function PixiePage() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? []);
  const current = usePixieViewStore((s) => s.current);
  const dispatches = usePixieViewStore((s) => s.dispatches);
  const error = usePixieViewStore((s) => s.error);
  const ensureCurrent = usePixieViewStore((s) => s.ensureCurrent);
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

  // Mount acquisition (re-run if the Host wasn't ready at first mount).
  useEffect(() => {
    if (!host) return;
    if (prevCwdRef.current === null) {
      // 记录进入前的工作区；已是 pixie 工作区（如冷启动直落 pixie 页）则不恢复。
      const before = useAppStore.getState().workspace?.canonicalCwd ?? null;
      const pixieCwd = usePixieViewStore.getState().current?.cwd;
      prevCwdRef.current = before && before !== pixieCwd ? before : null;
    }
    void acquire();
  }, [host, acquire]);

  // Leaving the pixie page: hand the active workspace back so the chat page
  // keeps showing whatever the user had before. Skipped when the user already
  // navigated elsewhere themselves.
  useEffect(() => {
    return () => {
      const pixieCwd = usePixieViewStore.getState().current?.cwd;
      const before = prevCwdRef.current;
      if (!before || !pixieCwd) return;
      if (useAppStore.getState().workspace?.canonicalCwd !== pixieCwd) return;
      void activateWorkspaceAcrossWorkspaces(before, { quiet: true });
    };
  }, []);

  // Callback/ask/stale events refresh the dispatch panel.
  useEffect(() => {
    if (!host) return;
    return hostClient.onEvent((event) => {
      if (
        event.event === "pixie.reportReceived" ||
        event.event === "pixie.askReceived" ||
        event.event === "pixie.staleWarning"
      ) {
        void refreshDispatches();
      }
    });
  }, [host, refreshDispatches]);

  useEffect(() => {
    if (!host) return;
    return hostClient.onEvent((event) => {
      if (event.event === "pixie.segmentChanged") void acquire();
    });
  }, [host, acquire]);

  // Dispatch polling: fast while anything is running, slow otherwise.
  const hasActiveDispatch = useMemo(
    () =>
      dispatches.some(
        (d) =>
          d.status === "dispatched" ||
          d.status === "queued" ||
          d.status === "paused" ||
          d.status === "awaiting_user",
      ),
    [dispatches],
  );
  useEffect(() => {
    if (!host) return;
    void refreshDispatches();
    const timer = setInterval(
      () => void refreshDispatches(),
      hasActiveDispatch ? DISPATCH_POLL_ACTIVE_MS : DISPATCH_POLL_IDLE_MS,
    );
    return () => clearInterval(timer);
  }, [host, hasActiveDispatch, refreshDispatches]);

  const awaitingDispatch = useMemo(
    () => dispatches.find((d) => d.status === "awaiting_user") ?? null,
    [dispatches],
  );

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

  const staleCount = useMemo(
    () =>
      dispatches.filter(
        (d) =>
          d.stale &&
          (d.status === "dispatched" || d.status === "paused" || d.status === "awaiting_user"),
      ).length,
    [dispatches],
  );
  const activeDispatches = useMemo(
    () =>
      dispatches.filter(
        (d) =>
          d.status === "dispatched" ||
          d.status === "queued" ||
          d.status === "paused" ||
          d.status === "awaiting_user" ||
          d.stale,
      ),
    [dispatches],
  );

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

  // 标准会话视图的就绪条件：锚点拿到且活动工作区确实是 pixie 工作区。
  const ready =
    !acquiring &&
    !acquireFailed &&
    current !== null &&
    workspace?.canonicalCwd === current.cwd &&
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
          {isNewConversation ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <Sparkles size={20} className="text-primary" />
              <p className="text-sm font-medium">{t("pixieEmptyTitle")}</p>
              <p className="max-w-sm text-xs text-muted">{t("pixieEmptyHint")}</p>
            </div>
          ) : (
            <Transcript />
          )}
          <div className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
            {error && <p className="mb-2 text-xs text-danger">{error}</p>}
            {awaitingDispatch && (
              <p className="mb-1.5 flex items-center gap-1.5 text-xs text-primary">
                ❓ {t("pixieAskPendingBanner")}
              </p>
            )}
            <ComposerRuntimeProvider runtime={runtime}>
              <Composer inputTestId="pixie-input" />
              <SessionStatsPills />
            </ComposerRuntimeProvider>
          </div>
        </div>

        {/* Delegation panel (30%) */}
        <div className="hidden min-h-0 flex-col border-l border-border @3xl:flex @3xl:w-[30%]">
          <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted">
            {t("pixieDispatchPanelTitle")}
          </div>
          {staleCount > 0 && (
            <div
              className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-[11px] text-warning"
              data-testid="pixie-stale-banner"
            >
              ⚠️ {t("pixieStaleBanner", { count: staleCount })}
            </div>
          )}
          <div className="scrollbar-subtle min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {dispatches.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">{t("pixieDispatchEmpty")}</p>
            ) : (
              dispatches.map((record) => (
                <DispatchRow
                  key={record.id}
                  record={record}
                  onReply={handleReplyInline}
                  onInterject={handleInterject}
                  onStop={handleStop}
                  onRetry={handleRetry}
                />
              ))
            )}
          </div>
          {activeDispatches.length > 0 && (
            <div className="shrink-0 border-t border-border px-3 py-2 text-[10px] text-muted">
              {t("pixieDispatchActiveCount", { count: activeDispatches.length })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
