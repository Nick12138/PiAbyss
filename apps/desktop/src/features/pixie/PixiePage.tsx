/**
 * Pixie (小精灵) conversation page — v4 workspace-ified single conversation
 * flow. The polled `pixie.state` segment timeline is rendered as ONE stream:
 * each segment's transcript goes through the shared projection pipeline
 * (`buildTranscriptRows` + `TranscriptRowView`), and consecutive segments are
 * separated only by a SleepChip — the user never sees session lists, names or
 * switch buttons. An awaiting ask flips the composer into reply mode; the
 * delegation panel shows the three callback kinds with inline reply.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Loader2, Sparkles } from "lucide-react";
import type {
  PixieAgentMessage,
  PixieAgentState,
  PixieDispatchRecord,
  PixieSegmentView,
  PixieSessionRundown,
  SessionSnapshot,
} from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";
import { TranscriptRowView } from "../chat/Transcript";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import type { SerializableAgentContent, SerializableAgentMessage } from "@piabyss/protocol";
import { Composer } from "../chat/Composer";
import { ComposerRuntimeProvider, type ComposerRuntime } from "../chat/composer-runtime";
import { SessionStatsPills } from "../chat/StatsPills";
import { usePixieViewStore } from "./pixie-store";
import { SleepChip } from "./SleepChip";

const POLL_IDLE_MS = 2_500;
const POLL_ACTIVE_MS = 1_200;
const RUNDOWN_TIMEOUT_MS = 30_000;

/**
 * 把 pixie.state + pixie.rundown 合成为共享输入框可消费的会话视图。
 * 小精灵段没有会话级 host 通道，这里只填输入框真正会读的字段：
 * isIdle / isCompacting / thinkingLevel / model / contextUsage / autoCompaction。
 */
function pixieSessionSnapshot(
  state: PixieAgentState | null,
  rundown: PixieSessionRundown | null,
): SessionSnapshot | null {
  if (!state) return null;
  const sessionId = state.sessionPath ?? "pixie";
  return {
    sessionId,
    cwd: "",
    revision: 0,
    isStreaming: state.running,
    isIdle: !state.running,
    isCompacting: rundown?.isCompacting ?? false,
    isRetrying: false,
    thinkingLevel: rundown?.thinkingLevel ?? "off",
    autoCompactionEnabled: rundown?.autoCompactionEnabled ?? false,
    autoRetryEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 0,
      workspaceId: "",
      sessionId,
      sessionRevision: 0,
      tools: [],
      active: [],
    },
    ...(rundown?.model
      ? {
          model: {
            provider: rundown.model.provider,
            modelId: rundown.model.id,
            name: rundown.model.id,
          },
        }
      : {}),
    ...(rundown?.contextUsage ? { contextUsage: rundown.contextUsage } : {}),
  };
}

/** Strip the `[pixie|channel]` marker so user messages read naturally. */
function stripSourceMarker(text: string): string {
  return text.replace(/^\[pixie\|[a-z]+\]\n?/, "");
}

/** Project one segment's transcript into shared transcript rows. */
function projectSegmentMessages(
  messages: PixieAgentMessage[],
  turnActive: boolean,
): TranscriptRow[] {
  const projected: SerializableAgentMessage[] = [];
  for (const message of messages) {
    const isUser = message.role === "user";
    let content = Array.isArray(message.content)
      ? (message.content as SerializableAgentContent[])
      : [];
    if (isUser) {
      content = content.map((block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          return { ...block, text: stripSourceMarker((block as { text: string }).text) };
        }
        return block;
      });
    }
    if (content.length === 0 && message.text) {
      content = [
        { type: "text" as const, text: isUser ? stripSourceMarker(message.text) : message.text },
      ];
    }
    if (content.length === 0) continue;
    projected.push({
      role: message.role === "toolResult" ? "toolResult" : message.role,
      content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.isError ? { isError: true } : {}),
    } as SerializableAgentMessage);
  }
  return buildTranscriptRows(projected, { turnActive });
}

/**
 * One delegation row in the right-hand panel: status badge (v4.1 状态机),
 * progress summary, artifacts, batch tag, escalation marker, and the action
 * row — inline reply (ask), interject (running), stop, resume/redispatch.
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
      {/* v4.1 action row */}
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
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? []);
  const state = usePixieViewStore((s) => s.state);
  const error = usePixieViewStore((s) => s.error);
  const refresh = usePixieViewStore((s) => s.refresh);
  const reply = usePixieViewStore((s) => s.reply);
  const pushContext = usePixieViewStore((s) => s.pushContext);
  const interject = usePixieViewStore((s) => s.interject);
  const stopDispatch = usePixieViewStore((s) => s.stopDispatch);
  const retryDispatch = usePixieViewStore((s) => s.retryDispatch);

  const [rundown, setRundown] = useState<PixieSessionRundown | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const lastCountRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const segments: PixieSegmentView[] = useMemo(() => state?.segments ?? [], [state]);
  const running = state?.running ?? false;
  const askPending = state?.askPending ?? false;
  const dispatches = useMemo(() => state?.dispatches ?? [], [state]);
  const awaitingDispatch = dispatches.find((d) => d.status === "awaiting_user") ?? null;

  /** 拉取小精灵段实时统计（模型/推理深度/用量/压缩态），供共享输入框消费。 */
  const refreshRundown = useCallback(async () => {
    const currentHost = useAppStore.getState().host;
    if (!currentHost) return;
    try {
      const res = await hostClient.request(
        "pixie.rundown",
        hostContext(currentHost),
        null,
        RUNDOWN_TIMEOUT_MS,
      );
      if (res.ok) setRundown(res.result);
    } catch {
      /* 统计为最佳努力，失败不清空上一帧 */
    }
  }, []);

  // Known-workspace push: on mount and whenever the list changes.
  useEffect(() => {
    void pushContext(knownWorkspaces);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push on identity change of the list
  }, [knownWorkspaces]);

  useEffect(() => {
    void refresh();
    void refreshRundown();
  }, [refresh, refreshRundown]);

  // Polling: fast while streaming (ScheduleAgentPage先例).
  useEffect(() => {
    const timer = setInterval(
      () => {
        void refresh();
        void refreshRundown();
      },
      running ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    );
    return () => clearInterval(timer);
  }, [refresh, refreshRundown, running]);

  // Instant refresh on callback/ask/segment/stale events.
  useEffect(() => {
    if (!host) return;
    return hostClient.onEvent((event) => {
      if (
        event.event === "pixie.reportReceived" ||
        event.event === "pixie.askReceived" ||
        event.event === "pixie.segmentChanged" ||
        event.event === "pixie.staleWarning"
      ) {
        void refresh();
      }
    });
  }, [host, refresh]);

  // Auto-scroll: new messages, user send, or already near the bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    const countIncreased = segments.length > lastCountRef.current;
    lastCountRef.current = segments.length;
    if (!userScrolledRef.current || isNearBottom || countIncreased) {
      el.scrollTop = el.scrollHeight;
      userScrolledRef.current = false;
    }
  }, [segments, running]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const handleScroll = () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (!isNearBottom) {
        userScrolledRef.current = true;
        setShowScrollToBottom(true);
      } else {
        setShowScrollToBottom(false);
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const rowsBySegment = useMemo(() => {
    const map = new Map<string, TranscriptRow[]>();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const isLast = index === segments.length - 1;
      map.set(segment.id, projectSegmentMessages(segment.messages, isLast && running));
    }
    return map;
  }, [segments, running]);

  const workingRowKey = useMemo(() => {
    if (!running || segments.length === 0) return undefined;
    const rows = rowsBySegment.get(segments[segments.length - 1]!.id) ?? [];
    const tail = rows[rows.length - 1];
    return tail?.role === "assistant" ? tail.key : undefined;
  }, [rowsBySegment, segments, running]);

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
  const staleCount = useMemo(
    () => dispatches.filter((d) => d.stale && (d.status === "dispatched" || d.status === "paused" || d.status === "awaiting_user")).length,
    [dispatches],
  );

  const isEmpty = segments.every((segment) => (rowsBySegment.get(segment.id) ?? []).length === 0);

  /**
   * 小精灵的 Composer 运行时：把共享输入框接到 pixie.* 通道上。发送复用
   * usePixieViewStore().send（内部已实现"有 awaiting 委派就走 pixie.reply"），
   * 其余能力一律走 HostContext 的 pixie.* RPC。
   */
  const pixieRuntime = useMemo<ComposerRuntime>(() => {
    const rpcTimeout = RUNDOWN_TIMEOUT_MS;
    return {
      variant: "pixie",
      host,
      session: pixieSessionSnapshot(state, rundown),
      draftKey: "pixie",
      rpcContext: host ? hostContext(host) : null,

      send: async ({ text, images, attachmentIds }) => {
        const ok = await usePixieViewStore.getState().send(text, images, attachmentIds);
        return ok ? { ok: true } : { ok: false, error: usePixieViewStore.getState().error };
      },

      abort: async () => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return;
        await hostClient.request("pixie.abort", hostContext(currentHost), null, rpcTimeout);
      },

      applySession: () => {
        /* 小精灵段由 Host 持有，前端不写回会话快照。 */
      },

      rundown: async () => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return null;
        const res = await hostClient.request(
          "pixie.rundown",
          hostContext(currentHost),
          null,
          rpcTimeout,
        );
        return res.ok ? res.result : null;
      },

      compact: async (instructions) => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return { ok: false, error: null };
        const res = await hostClient.request(
          "pixie.compact",
          hostContext(currentHost),
          instructions ? { instructions } : null,
          rpcTimeout,
        );
        if (!res.ok) return { ok: false, error: res.error?.message ?? null };
        const { tokensBefore, tokensAfter } = res.result;
        if (typeof tokensBefore === "number" && typeof tokensAfter === "number") {
          useAppStore
            .getState()
            .pushNotification(
              t("notifCompacted", {
                before: formatTokenCount(tokensBefore),
                after: formatTokenCount(tokensAfter),
              }),
              "info",
            );
        } else {
          useAppStore.getState().pushNotification(t("notifCompactedPlain"), "info");
        }
        void refreshRundown();
        return { ok: res.result.ok, error: res.result.error };
      },

      abortCompaction: async () => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return;
        await hostClient.request("pixie.abortCompaction", hostContext(currentHost), null, rpcTimeout);
        void refreshRundown();
      },

      setAutoCompaction: async (enabled) => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return;
        await hostClient.request(
          "pixie.setAutoCompaction",
          hostContext(currentHost),
          { enabled },
          rpcTimeout,
        );
        void refreshRundown();
      },

      listModels: async () => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return null;
        const res = await hostClient.request("pixie.models", hostContext(currentHost), null, rpcTimeout);
        return res.ok ? res.result : null;
      },

      setModel: async (model, thinkingLevel) => {
        const currentHost = useAppStore.getState().host;
        if (!currentHost) return { ok: false, error: null };
        const res = await hostClient.request(
          "pixie.setModel",
          hostContext(currentHost),
          { model, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) },
          rpcTimeout,
        );
        if (!res.ok) return { ok: false, error: res.error?.message ?? null };
        void refreshRundown();
        return { ok: res.result.ok, error: res.result.error };
      },
    };
  }, [host, state, rundown, refreshRundown, t]);

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

  function scrollToBottom() {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      userScrolledRef.current = false;
      setShowScrollToBottom(false);
    }
  }

  return (
    <div className="@container flex h-full min-w-0 flex-col" data-pixie-page>
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        {/* Conversation (70%) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:flex-[7]">
          <div className="relative isolate min-h-0 flex-1">
            <div
              ref={transcriptRef}
              className="scrollbar-subtle h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-5"
            >
              <div className="conversation-content-width mx-auto flex flex-col gap-5 sm:gap-6">
                {isEmpty && !error && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <Sparkles size={20} className="text-primary" />
                    <p className="text-sm font-medium">{t("pixieEmptyTitle")}</p>
                    <p className="max-w-sm text-xs text-muted">{t("pixieEmptyHint")}</p>
                  </div>
                )}
                {segments.map((segment, index) => {
                  const rows = rowsBySegment.get(segment.id) ?? [];
                  const archived = segment.endedAt === null && rows.length === 0;
                  return (
                    <div key={segment.id} className="flex flex-col gap-5 sm:gap-6">
                      {rows.length === 0 && archived && (
                        <p className="text-center text-[11px] text-muted">
                          {t("pixieSegmentArchived")}
                        </p>
                      )}
                      {rows.map((row) => (
                        <div className="transcript-row" data-row-key={row.key} key={row.key}>
                          <TranscriptRowView
                            row={row}
                            mode={row.key === workingRowKey ? "streaming" : "static"}
                            showCaret={row.key === workingRowKey}
                            working={row.key === workingRowKey}
                            retryableTurn={undefined}
                            retryVisible={false}
                            goOnVisible={false}
                            onRetry={async () => undefined}
                            readOnly
                            userCollapsible={false}
                            userExpanded={false}
                            onToggleUser={undefined}
                          />
                        </div>
                      ))}
                      {(running || rows.some((row) => row.key === workingRowKey)) &&
                        index === segments.length - 1 &&
                        !workingRowKey && (
                          <div className="flex items-center gap-1.5 px-1 text-xs text-muted">
                            <Loader2 size={12} className="animate-spin" />
                            {t("pixieThinking")}
                          </div>
                        )}
                      {segment.endedAt !== null && <SleepChip segment={segment} />}
                    </div>
                  );
                })}
              </div>
            </div>
            {showScrollToBottom && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow-md transition-colors hover:bg-surface-overlay hover:text-foreground"
                title={t("transcriptScrollToBottom")}
                aria-label={t("transcriptScrollToBottom")}
              >
                <ArrowDown size={15} />
              </button>
            )}
          </div>
          <div className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
            {error && <p className="mb-2 text-xs text-danger">{error}</p>}
            {askPending && awaitingDispatch && (
              <p className="mb-1.5 flex items-center gap-1.5 text-xs text-primary">
                ❓ {t("pixieAskPendingBanner")}
              </p>
            )}
            <ComposerRuntimeProvider runtime={pixieRuntime}>
              {/* 共享输入框：模型切换 / 附件 / 命令补全 / 发送-停止。运行中禁发。 */}
              <Composer disabled={running} inputTestId="pixie-input" />
              {/* 速度 / 缓存 / 上下文用量 + 压缩入口（数据源为 pixie.rundown）。 */}
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
            <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-[11px] text-warning" data-testid="pixie-stale-banner">
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
