import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CircleAlert, LoaderCircle, Pause, Play, RotateCcw, Square } from "lucide-react";
import type { SubagentSessionSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import { TranscriptRowView } from "../chat/Transcript";
import {
  flattenNodes,
  subagentRoleEmoji,
  subagentRoleLabel,
  subagentStateClass,
  subagentStateLabel,
} from "./subagent-model";

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
        await hostClient.request(method, workspaceContext(host, workspace), { nodeId }, 15_000);
      } finally {
        setPendingActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [host, workspace, nodeId],
  );

  const isPending = (action: string) =>
    nodeId !== null && pendingActions.has(`${nodeId}:${action}`);

  const queued = node?.state === "queued";
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
        { nodeId, message },
        15_000,
      );
      if (response.ok) {
        setDraft("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
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
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  if (!nodeId || !node) return null;

  const role = node.role?.trim();
  const localizedRole = subagentRoleLabel(role, t);
  const roleBadge = subagentRoleEmoji(role) ?? localizedRole;

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

      <footer className="shrink-0 px-4 pb-4 pt-1">
        <div className="conversation-content-width mx-auto flex flex-col gap-1.5">
          {sendError && (
            <div
              role="alert"
              className="flex items-center gap-1.5 text-xs text-danger"
              data-subagent-send-error
            >
              <CircleAlert size={13} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{sendError}</span>
            </div>
          )}
          <div className="theme-composer-surface flex items-end gap-1.5 rounded-xl border border-border bg-surface-overlay px-3 py-2">
            <textarea
              ref={textareaRef}
              className="max-h-40 min-h-9 flex-1 resize-none self-center bg-transparent text-sm leading-6 outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50"
              rows={1}
              placeholder={t("subagentComposerPlaceholder")}
              disabled={queued}
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              data-subagent-composer
            />
            <div className="flex shrink-0 items-center gap-1 self-center">
              {node.state === "running" && (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded text-warning transition-colors hover:bg-warning/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsPause")}
                  aria-label={t("subagentsPause")}
                  disabled={isPending("pause")}
                  onClick={() => void runControl("pause")}
                >
                  <Pause size={13} fill="currentColor" />
                </button>
              )}
              {node.state === "paused" && (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded text-success transition-colors hover:bg-success/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsContinue")}
                  aria-label={t("subagentsContinue")}
                  disabled={isPending("continue")}
                  onClick={() => void runControl("continue")}
                >
                  <Play size={13} fill="currentColor" />
                </button>
              )}
              {node.state === "failed" && (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded text-success transition-colors hover:bg-success/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsResume")}
                  aria-label={t("subagentsResume")}
                  disabled={isPending("resume")}
                  onClick={() => void runControl("resume")}
                >
                  <RotateCcw size={13} />
                </button>
              )}
              {(node.state === "running" || node.state === "paused" || node.state === "queued") && (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded text-danger transition-colors hover:bg-danger/15 disabled:cursor-wait disabled:opacity-60"
                  title={t("subagentsStop")}
                  aria-label={t("subagentsStop")}
                  disabled={isPending("stop")}
                  onClick={() => void runControl("stop")}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              )}
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
                  <ArrowUp size={17} strokeWidth={2.25} className="block shrink-0" />
                )}
              </button>
            </div>
          </div>
          <div className="flex min-h-4 items-center gap-2 text-[11px] text-muted">
            <span className={subagentStateClass(node.state)}>
              {subagentStateLabel(node.state, t)}
            </span>
            {roleBadge && role !== (node.name ?? node.label) && <span aria-hidden="true">·</span>}
            {roleBadge && role !== (node.name ?? node.label) && (
              <span title={t("subagentsRole", { role: localizedRole ?? "" })}>{roleBadge}</span>
            )}
            {node.model && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{t("subagentsModel", { model: node.model })}</span>
              </>
            )}
            {queued && (
              <span className="ml-auto shrink-0 text-warning">
                {t("subagentComposerQueuedHint")}
              </span>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
}
