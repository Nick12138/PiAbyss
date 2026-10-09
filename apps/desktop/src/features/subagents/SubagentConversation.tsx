import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CircleAlert, LoaderCircle, Pause, Play, RotateCcw, Square } from "lucide-react";
import type { SubagentSessionSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import { TranscriptRowView } from "../chat/Transcript";
import { flattenNodes } from "./subagent-model";
import { SubagentModelPicker } from "./SubagentModelPicker";
import {
  getPendingSubagentOverride,
  setPendingSubagentOverride,
  type SubagentModelOverride,
} from "./subagent-pending-model";

/** Full-page conversation surface for the active subagent run. Replaces the
 * former right-dock panel expansion: the chat area renders the run's
 * transcript with the main session's turn-fold presentation, and the composer
 * sends user messages through `subagents.send` (steer to a live child,
 * resume-with-message for a finished run). Run controls mirror the main
 * session's pause/stop affordances. */
export function SubagentConversation() {
  const t = useT();
  const activeSubagentNodeId = useAppStore((s) => s.activeSubagentNodeId);
  const status = useAppStore((s) => s.subagentsStatus);
  const setActiveSubagent = useAppStore((s) => s.setActiveSubagent);
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);

  const [snapshot, setSnapshot] = useState<SubagentSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set());
  // Pending model/thinking override picked in this view (see
  // subagent-pending-model): rides along with the next send / resume,
  // cleared once a respawn consumed it (mode "resume" / successful resume
  // control).
  const [pendingOverride, setPendingOverride] = useState<SubagentModelOverride | undefined>(() =>
    getPendingSubagentOverride(activeSubagentNodeId),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);

  const node = useMemo(
    () =>
      activeSubagentNodeId
        ? (flattenNodes(status.runs).find(({ node }) => node.id === activeSubagentNodeId)?.node ??
          null)
        : null,
    [status.runs, activeSubagentNodeId],
  );

  // A rebuilt status without this node (host restart, run pruning) means the
  // view is stale — fall back to the main session instead of an orphan page.
  useEffect(() => {
    if (activeSubagentNodeId && status.available && !node) {
      setActiveSubagent(null);
    }
  }, [activeSubagentNodeId, status.available, node, setActiveSubagent]);

  // Drop the stale transcript when switching runs so the next snapshot never
  // renders the previous subagent's entries.
  useEffect(() => {
    setSnapshot(null);
    setLoadError(false);
    setSendError(null);
    stickToBottomRef.current = true;
    setPendingOverride(getPendingSubagentOverride(activeSubagentNodeId));
  }, [activeSubagentNodeId]);

  const nodeId = activeSubagentNodeId;
  const loadSession = useCallback(async () => {
    if (!host || !workspace || !nodeId) return;
    setLoading(true);
    try {
      const response = await hostClient.request(
        "subagents.getSession",
        workspaceContext(host, workspace),
        { nodeId },
        15_000,
      );
      if (response.ok) {
        setSnapshot(response.result);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [host, workspace, nodeId]);

  // Load on entry and re-poll while the run is alive. The node's primitive
  // state drives the lifecycle so status polls that only refresh object
  // identity don't re-arm the effect.
  const nodeState = node?.state;
  useEffect(() => {
    if (!nodeId) return;
    void loadSession();
    if (nodeState !== "running") return;
    const interval = window.setInterval(() => void loadSession(), 1_500);
    return () => window.clearInterval(interval);
  }, [nodeId, nodeState, loadSession]);

  const rows = useMemo(
    () =>
      snapshot
        ? buildTranscriptRows([], {
            entries: snapshot.entries,
            turnActive: snapshot.state === "running",
          })
        : [],
    [snapshot],
  );

  // Streaming tail: while the run is active the last assistant row renders in
  // the main session's live style (caret + working header).
  const tailRow = rows[rows.length - 1];
  const workingRowKey =
    snapshot?.state === "running" && tailRow?.role === "assistant" ? tailRow.key : undefined;

  const renderRow = (row: TranscriptRow) => {
    const working = row.key === workingRowKey;
    return (
      <div className="transcript-row" data-row-key={row.key} key={row.key}>
        <TranscriptRowView
          row={row}
          mode={working ? "streaming" : "static"}
          showCaret={working}
          working={working}
          retryableTurn={undefined}
          retryVisible={false}
          goOnVisible={false}
          onRetry={async () => undefined}
          readOnly
        />
      </div>
    );
  };

  // Follow the conversation tail unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, loading]);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const runControl = useCallback(
    async (action: "stop" | "pause" | "continue" | "resume") => {
      if (!host || !workspace || !nodeId) return;
      const key = `${nodeId}:${action}`;
      setPendingActions((current) => new Set(current).add(key));
      try {
        const method = {
          stop: "subagents.stop",
          pause: "subagents.pause",
          continue: "subagents.continue",
          resume: "subagents.resume",
        }[action] as
          "subagents.stop" | "subagents.pause" | "subagents.continue" | "subagents.resume";
        const response = await hostClient.request(
          method,
          workspaceContext(host, workspace),
          // A resume respawns the child, so the pending model/thinking
          // override applies there; other controls operate on the live
          // process.
          action === "resume" && pendingOverride
            ? {
                nodeId,
                ...(pendingOverride.model !== undefined ? { model: pendingOverride.model } : {}),
                ...(pendingOverride.thinking !== undefined
                  ? { thinking: pendingOverride.thinking }
                  : {}),
              }
            : { nodeId },
          15_000,
        );
        if (response.ok && action === "resume" && pendingOverride) {
          setPendingSubagentOverride(nodeId, undefined);
          setPendingOverride(undefined);
        }
      } finally {
        setPendingActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [host, workspace, nodeId, pendingOverride],
  );

  const isPending = (action: string) =>
    nodeId !== null && pendingActions.has(`${nodeId}:${action}`);

  const queued = node?.state === "queued";
  const stoppable =
    node?.state === "running" || node?.state === "paused" || node?.state === "queued";
  const canSend = !sending && !queued && draft.trim().length > 0;

  const send = async () => {
    if (!canSend || !host || !workspace || !nodeId) return;
    const message = draft.trim();
    setSending(true);
    setSendError(null);
    try {
      const response = await hostClient.request(
        "subagents.send",
        workspaceContext(host, workspace),
        // The pending model/thinking override rides with this message; it is
        // consumed when the plugin respawns a finished run (mode "resume").
        // A steer to a live process cannot hot-swap either, so the override
        // stays pending for the eventual respawn.
        pendingOverride
          ? {
              nodeId,
              message,
              ...(pendingOverride.model !== undefined ? { model: pendingOverride.model } : {}),
              ...(pendingOverride.thinking !== undefined
                ? { thinking: pendingOverride.thinking }
                : {}),
            }
          : { nodeId, message },
        15_000,
      );
      if (response.ok) {
        setDraft("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        if (response.result.mode === "resume" && pendingOverride) {
          setPendingSubagentOverride(nodeId, undefined);
          setPendingOverride(undefined);
        }
        // Resume-with-message restarts the run; an immediate refresh picks up
        // the new turn faster than the poll interval.
        void loadSession();
      } else {
        setSendError(response.error?.message ?? t("composerSendFailed"));
      }
    } catch {
      setSendError(t("composerSendFailed"));
    } finally {
      setSending(false);
    }
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  if (!nodeId || !node) return null;

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={node.name ?? node.label}
      data-subagent-conversation
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto"
      >
        <div className="conversation-content-width mx-auto flex flex-col gap-5 px-3 py-4 sm:gap-6">
          {snapshot?.truncated && (
            <div className="rounded border border-border bg-surface-overlay px-2 py-1.5 text-[10px] text-muted">
              {t("subagentsConversationTruncated")}
            </div>
          )}
          {!snapshot ? (
            loadError ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-xs text-muted">
                <span className="text-danger">{t("subagentsLoadFailed")}</span>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-muted hover:bg-surface-overlay hover:text-foreground"
                  onClick={() => void loadSession()}
                >
                  {t("transcriptRetryMessage")}
                </button>
              </div>
            ) : (
              <div className="flex min-h-40 items-center justify-center gap-3 text-xs text-muted">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                {t("subagentsLoadingConversation")}
              </div>
            )
          ) : rows.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center text-center text-xs text-muted">
              {node.state === "running" ? t("transcriptPiWorking") : t("subagentsNoConversation")}
            </div>
          ) : (
            <>
              {rows.map((row) => renderRow(row))}
              {node.state === "running" && !workingRowKey && (
                <div className="transcript-row flex items-center gap-3 text-xs text-muted">
                  <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                  <span>{t("transcriptPiWorking")}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="shrink-0 px-5 pb-5 pt-2">
        <div className="conversation-content-width mx-auto w-full">
          {sendError && (
            <div
              role="alert"
              className="flex items-center gap-1.5 pb-1.5 text-xs text-danger"
              data-subagent-send-error
            >
              <CircleAlert size={13} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{sendError}</span>
            </div>
          )}
          {/* Same surface as the main chat composer (chat-composer-surface) so
              the subagent view's input reads as the same control, not a
              variant: identical border, background, padding and internal
              textarea-above / toolbar-below layout. */}
          <div className="chat-composer-surface rounded-xl border-[1.5px] border-border bg-surface-raised p-2 shadow-sm">
            <textarea
              ref={textareaRef}
              className="chat-composer-input min-h-[60px] max-h-[280px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50"
              rows={1}
              placeholder={t("subagentComposerPlaceholder")}
              disabled={queued}
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              data-subagent-composer
            />
            <div className="composer-toolbar flex h-8 items-center gap-2.5 px-1">
              {node.state === "running" && (
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-md text-warning transition-colors hover:bg-warning/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsPause")}
                  aria-label={t("subagentsPause")}
                  disabled={isPending("pause")}
                  onClick={() => void runControl("pause")}
                >
                  <Pause size={14} fill="currentColor" />
                </button>
              )}
              {node.state === "paused" && (
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-md text-success transition-colors hover:bg-success/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsContinue")}
                  aria-label={t("subagentsContinue")}
                  disabled={isPending("continue")}
                  onClick={() => void runControl("continue")}
                >
                  <Play size={14} fill="currentColor" />
                </button>
              )}
              {node.state === "failed" && (
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-md text-success transition-colors hover:bg-success/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsResume")}
                  aria-label={t("subagentsResume")}
                  disabled={isPending("resume")}
                  onClick={() => void runControl("resume")}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              {/* Merged send/stop control on the right, mirroring the main
                  composer: while the run is alive the slot is the stop
                  button, and switches to send as soon as the user has a
                  draft to steer/queue; pause/continue/resume stay
                  independent on the left. */}
              <div className="ml-auto flex items-center gap-2.5">
                <SubagentModelPicker
                  currentModel={node.model ?? undefined}
                  currentThinking={node.thinking}
                  override={pendingOverride}
                  onChange={(next) => {
                    if (!nodeId) return;
                    setPendingSubagentOverride(nodeId, next);
                    setPendingOverride(next);
                  }}
                />
                {stoppable && !canSend ? (
                  <button
                    type="button"
                    title={t("subagentsStop")}
                    aria-label={t("subagentsStop")}
                    className="flex size-7 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/20 disabled:cursor-wait disabled:opacity-60"
                    disabled={isPending("stop")}
                    onClick={() => void runControl("stop")}
                    data-subagent-stop
                  >
                    <Square size={14} fill="currentColor" className="block shrink-0" />
                  </button>
                ) : (
                  <button
                    type="button"
                    title={t("composerSend")}
                    aria-label={t("composerSend")}
                    className="theme-send-control flex size-7 items-center justify-center rounded-full bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                    disabled={!canSend}
                    onClick={() => void send()}
                    data-subagent-send
                  >
                    {sending ? (
                      <LoaderCircle size={15} className="animate-spin" />
                    ) : (
                      <ArrowUp size={18} strokeWidth={2.25} className="block shrink-0" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* No status line under the composer: run state is carried by the
              toolbar (pause/stop affordances + spinner), the role emoji by
              the top-bar breadcrumb, and the model by the picker itself. */}
        </div>
      </footer>
    </section>
  );
}
