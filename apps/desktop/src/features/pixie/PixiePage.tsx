/**
 * Pixie (小精灵) conversation page — the dedicated chat surface for the
 * Host-owned resident helper session.
 *
 * Same projection pipeline as the schedule agent page: the polled
 * `pixie.state` transcript goes through `buildTranscriptRows`, so reasoning
 * and tool calls fold exactly like a workspace session. The delegation list
 * shows the live `pixie_dispatch → pixie_report` loop (dispatched →
 * reported/failed, with the stale marker after 30 minutes).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Sparkles } from "lucide-react";
import type { PixieAgentMessage, PixieDispatchRecord } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { TranscriptRowView } from "../chat/Transcript";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import type { SerializableAgentContent, SerializableAgentMessage } from "@piabyss/protocol";

const STATE_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;
const POLL_IDLE_MS = 2_500;
const POLL_ACTIVE_MS = 1_200;

/** Session file of the last known pixie singleton (kept across remounts so a
 *  Host restart can fork-continue instead of starting fresh). */
const LAST_SESSION_KEY = "piabyss.pixie.lastSessionPath.v1";

function lastKnownSessionPath(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

function rememberSessionPath(path: string | null): void {
  try {
    if (path) globalThis.localStorage?.setItem(LAST_SESSION_KEY, path);
    else globalThis.localStorage?.removeItem(LAST_SESSION_KEY);
  } catch {
    /* unavailable */
  }
}

/** One delegation row in the right-hand panel. */
function DispatchRow({ record }: { record: PixieDispatchRecord }) {
  const statusLabel =
    record.status === "dispatched"
      ? record.stale
        ? "进行中（未按时回调）"
        : "进行中"
      : record.status === "reported"
        ? "已完成"
        : "失败";
  const statusClass =
    record.status === "reported"
      ? "text-success"
      : record.status === "failed"
        ? "text-danger"
        : record.stale
          ? "text-warning"
          : "text-muted";
  return (
    <div className="rounded-md border border-border bg-surface-raised p-2.5 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={`font-medium ${statusClass}`}>{statusLabel}</span>
        <span className="text-[10px] text-muted">
          {new Date(record.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <p className="line-clamp-3 text-foreground/90">{record.task}</p>
      {record.report && (
        <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap border-t border-border pt-1.5 text-muted">
          {record.report}
        </p>
      )}
    </div>
  );
}

export function PixiePage() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const [messages, setMessages] = useState<PixieAgentMessage[]>([]);
  const [dispatches, setDispatches] = useState<PixieDispatchRecord[]>([]);
  const [resident, setResident] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const lastCountRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const refresh = useCallback(async () => {
    if (!host) return;
    try {
      const state = await hostClient.request(
        "pixie.state",
        hostContext(host),
        null,
        STATE_TIMEOUT_MS,
      );
      if (!state.ok) {
        setLoadError(state.error?.message ?? t("pixieLoadFailed"));
        return;
      }
      setResident(state.result.resident);
      setRunning(state.result.running);
      setMessages(state.result.messages);
      setDispatches(state.result.dispatches);
      setLoadError(null);
      if (state.result.sessionPath) rememberSessionPath(state.result.sessionPath);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("pixieLoadFailed"));
    }
  }, [host, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), running ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, running]);

  // React to callbacks instantly: the Host pushes pixie.reportReceived when a
  // delegated session reports back.
  useEffect(() => {
    if (!host) return;
    return hostClient.onEvent((event) => {
      if (event.event === "pixie.reportReceived") void refresh();
    });
  }, [host, refresh]);

  // Auto-scroll: new messages, user send, or already near the bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    const countIncreased = messages.length > lastCountRef.current;
    lastCountRef.current = messages.length;
    if (!userScrolledRef.current || isNearBottom || countIncreased) {
      el.scrollTop = el.scrollHeight;
      userScrolledRef.current = false;
    }
  }, [messages]);

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

  /** Project the polled transcript into the shared transcript rows. */
  const rows = useMemo<TranscriptRow[]>(() => {
    const projected: SerializableAgentMessage[] = [];
    for (const message of messages) {
      const content = Array.isArray(message.content)
        ? (message.content as SerializableAgentContent[])
        : message.text
          ? [{ type: "text" as const, text: message.text }]
          : [];
      if (content.length === 0) continue;
      projected.push({
        role: message.role === "toolResult" ? "toolResult" : message.role,
        content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.isError ? { isError: true } : {}),
      } as SerializableAgentMessage);
    }
    return buildTranscriptRows(projected, { turnActive: running });
  }, [messages, running]);

  const workingRowKey = useMemo(() => {
    if (!running) return undefined;
    const tail = rows[rows.length - 1];
    return tail?.role === "assistant" ? tail.key : undefined;
  }, [rows, running]);

  const activeDispatches = useMemo(
    () => dispatches.filter((d) => d.status === "dispatched" || d.stale),
    [dispatches],
  );

  async function send() {
    const text = draft.trim();
    if (!text || sending || !host || running) return;
    setSending(true);
    setLoadError(null);
    setDraft("");
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
    try {
      const storedPath = lastKnownSessionPath();
      const useContinue = !resident && storedPath;
      const response = useContinue
        ? await hostClient.request(
            "pixie.continue",
            hostContext(host),
            { sessionPath: storedPath!, text },
            SEND_TIMEOUT_MS,
          )
        : await hostClient.request("pixie.send", hostContext(host), { text }, SEND_TIMEOUT_MS);
      if (!response.ok) {
        setLoadError(response.error?.message ?? t("pixieLoadFailed"));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("pixieLoadFailed"));
    } finally {
      setSending(false);
      void refresh();
    }
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
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles size={14} className="text-primary" />
        <span className="text-sm font-medium">{t("pixieTitle")}</span>
        <span className="text-xs text-muted">{t("pixieHeaderHint")}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        {/* Conversation (70%) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:flex-[7]">
          <div className="relative isolate min-h-0 flex-1">
            <div
              ref={transcriptRef}
              className="scrollbar-subtle h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-5"
            >
              <div className="conversation-content-width mx-auto flex flex-col gap-5 sm:gap-6">
                {messages.length === 0 && !loadError && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <Sparkles size={20} className="text-primary" />
                    <p className="text-sm font-medium">{t("pixieEmptyTitle")}</p>
                    <p className="max-w-sm text-xs text-muted">{t("pixieEmptyHint")}</p>
                  </div>
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
                {running && !workingRowKey && (
                  <div className="flex items-center gap-1.5 px-1 text-xs text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    {t("pixieThinking")}
                  </div>
                )}
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
            {loadError && <p className="mb-2 text-xs text-danger">{loadError}</p>}
            <div className="chat-composer-surface rounded-xl border-[1.5px] border-border bg-surface-raised p-2 shadow-sm">
              <textarea
                data-testid="pixie-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={t("pixieInputPlaceholder")}
                className="chat-composer-input min-h-[48px] max-h-[200px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
              />
              <div className="composer-toolbar flex h-8 items-center justify-end px-1">
                <button
                  type="button"
                  title={t("composerSend")}
                  aria-label={t("composerSend")}
                  className="theme-send-control flex size-7 items-center justify-center rounded-full bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                  disabled={sending || running || !draft.trim()}
                  onClick={() => void send()}
                >
                  {sending || running ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ArrowUp size={18} strokeWidth={2.25} className="block shrink-0" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Delegation panel (30%) */}
        <div className="hidden min-h-0 flex-col border-l border-border @3xl:flex @3xl:w-[30%]">
          <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted">
            {t("pixieDispatchPanelTitle")}
          </div>
          <div className="scrollbar-subtle min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {dispatches.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">{t("pixieDispatchEmpty")}</p>
            ) : (
              dispatches.map((record) => <DispatchRow key={record.id} record={record} />)
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
