import { useState } from "react";
import { ChevronDown, Pencil, Play, Trash2, ArrowUp, Check, Paperclip, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import { activeSessionContext } from "../../lib/bridge/host-context";
import { useImeComposition } from "../../lib/use-ime-composition";
import {
  parseAttachmentReferences,
  preserveAttachmentReferenceBlocks,
  stripAttachmentReferenceBlocks,
  type ActiveSessionContext,
} from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import {
  appendOptimisticUserMessage,
  removeOptimisticUserMessage,
} from "../../lib/chat/optimistic-echo";

/**
 * Waiting queue above the composer. Backed by the SDK queue (visible to the
 * CLI too); reorder/edit/delete use revisioned agent.setQueue transactions.
 * "Run now" is one Host-owned interrupt/start/restore transaction — for both
 * queue kinds the Host settles the active run first, then sends the item as a
 * fresh turn, so Run Now is offered even while the session is running.
 */

/** Transient conditions worth a short retry — e.g. the operation lock of an
 * aborted run releases a beat after agent.abort responds. */
const RETRYABLE_CODES = new Set(["AGENT_BUSY", "SERVICE_GRAPH_BUSY", "PACKAGE_MUTATION_BUSY"]);

function QueueText({ raw }: { raw: string }) {
  const t = useT();
  const visible = stripAttachmentReferenceBlocks(raw).trim();
  const attachments = parseAttachmentReferences(raw);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs leading-4" title={visible}>
      <span className="min-w-0 flex-1 truncate">{visible || t("queueAttachmentOnly")}</span>
      {attachments.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted">
          <Paperclip size={10} />
          {attachments.length}
        </span>
      )}
    </span>
  );
}

async function setQueueWithRetry(
  context: ActiveSessionContext,
  params: { expectedRevision: number; steering: string[]; followUp: string[] },
) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await hostClient.request("agent.setQueue", context, params);
    if (res.ok || attempt >= 3 || !RETRYABLE_CODES.has(res.error?.code ?? "")) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function QueuePanel() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [collapsed, setCollapsed] = useState(false);
  const [busyOp, setBusyOp] = useState(false);
  const [editing, setEditing] = useState<{
    kind: "steering" | "followUp";
    index: number;
    text: string;
    original: string;
  } | null>(null);
  const ime = useImeComposition();

  const steering = session?.pending.steering ?? [];
  const followUp = session?.pending.followUp ?? [];
  const total = steering.length + followUp.length;
  if (!session || total === 0) return null;

  async function applyQueue(nextSteering: string[], nextFollowUp: string[]) {
    if (!host || !workspace || !session || busyOp) return;
    setBusyOp(true);
    try {
      const res = await setQueueWithRetry(activeSessionContext(host, workspace, session), {
        expectedRevision: session.pending.revision,
        steering: nextSteering,
        followUp: nextFollowUp,
      });
      if (!res.ok) {
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
      }
    } finally {
      setBusyOp(false);
    }
  }

  async function runNow(kind: "followUp" | "steering", index: number) {
    if (!host || !workspace || !session || busyOp) return;
    const queuedText = kind === "followUp" ? followUp[index] : (steering[index] ?? undefined);
    if (queuedText === undefined) return;
    const targetSessionId = session.sessionId;
    const targetSessionRevision = session.revision;
    // The queued item starts a real turn immediately; echo it into the
    // transcript without waiting for the Host's message_start (which can lag
    // behind SDK preflight). A rejected/failed start rolls the row back; the
    // authoritative message then claims it in place.
    const optimisticKey = appendOptimisticUserMessage(queuedText, session.sessionId);
    setBusyOp(true);
    try {
      const context = activeSessionContext(host, workspace, session);
      const response = await hostClient.request("agent.runNow", context, {
        expectedRevision: session.pending.revision,
        ...(kind === "followUp" ? { followUpIndex: index } : { steeringIndex: index }),
      });
      if (!response.ok) {
        removeOptimisticUserMessage(optimisticKey);
        pushNotification(localizeHostError(response.error, t), hostErrorLevel(response.error));
        return;
      }
      if (response.result.started !== true) {
        // The item could not start (lock/abort race) — roll the echo back.
        removeOptimisticUserMessage(optimisticKey);
      }
      const current = useAppStore.getState().session;
      if (
        current?.sessionId === targetSessionId &&
        current.revision === targetSessionRevision &&
        response.result.queue.revision >= current.pending.revision
      ) {
        setSession({
          ...current,
          pending: response.result.queue,
        });
      }
      if (response.result.error) {
        pushNotification(response.result.error.message, "error");
      }
    } finally {
      setBusyOp(false);
    }
  }

  const itemButton =
    "flex size-6 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-30";

  /** Persist the in-flight edit with a revisioned agent.setQueue transaction,
   * preserving managed attachment reference blocks. An emptied text keeps the
   * original item (same contract the follow-up editor always had). */
  function commitEdit() {
    if (!editing) return;
    const next = [...(editing.kind === "steering" ? steering : followUp)];
    if (editing.text.trim()) {
      next[editing.index] = preserveAttachmentReferenceBlocks(editing.original, editing.text);
    }
    void applyQueue(
      editing.kind === "steering" ? next : [...steering],
      editing.kind === "followUp" ? next : [...followUp],
    );
    setEditing(null);
  }

  /** Shared inline editor row for one queued item (steering or follow-up). */
  const editRow = (kind: "steering" | "followUp", index: number) => {
    if (!editing || editing.kind !== kind || editing.index !== index) return null;
    return (
      <li key={`edit:${kind}:${index}`} className="flex items-start gap-1.5 rounded px-1.5 py-1">
        <textarea
          autoFocus
          aria-label={t("queueEditMessage")}
          className="min-h-[52px] flex-1 rounded border border-accent bg-surface px-2 py-1 text-xs outline-none"
          value={editing.text}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(event) => {
            if (ime.isImeKey(event)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commitEdit();
            }
            if (event.key === "Escape") setEditing(null);
          }}
        />
        <button
          type="button"
          title={t("queueSave")}
          aria-label={t("queueSave")}
          className={itemButton}
          onClick={() => commitEdit()}
        >
          <Check size={13} />
        </button>
        <button
          type="button"
          title={t("queueCancel")}
          aria-label={t("queueCancel")}
          className={itemButton}
          onClick={() => setEditing(null)}
        >
          <X size={13} />
        </button>
      </li>
    );
  };

  const startEdit = (kind: "steering" | "followUp", index: number, text: string) =>
    setEditing({
      kind,
      index,
      text: stripAttachmentReferenceBlocks(text).trim(),
      original: text,
    });

  return (
    <div className="conversation-content-width mx-auto mb-1.5 w-full rounded-lg border border-border bg-surface-raised/80">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 px-3 text-xs text-muted hover:text-foreground"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="font-medium">{t("queueTitle", { count: total })}</span>
        <ChevronDown
          size={13}
          className={`ml-auto transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      {!collapsed && (
        <ul className="border-t border-border px-1.5 py-1">
          {steering.map((text, index) =>
            editRow("steering", index) ?? (
              <li
                key={`steer:${index}`}
                className="group flex items-start gap-2 rounded px-1.5 py-1 hover:bg-surface-overlay/50"
              >
                <span className="mt-0.5 shrink-0 rounded bg-warning/15 px-1 text-[10px] font-medium leading-none text-warning">
                  {t("queueSteering")}
                </span>
                <QueueText raw={text} />
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title={t("queueEdit")}
                    aria-label={t("queueEdit")}
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() => startEdit("steering", index, text)}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    // The Host's runNow transaction settles the active run
                    // first, so this is offered even while the session runs —
                    // clicking then aborts the run and sends the steering
                    // text as a fresh turn.
                    title={
                      session.isIdle ? t("queueRunNowSteeringIdle") : t("queueRunNowSteeringBusy")
                    }
                    aria-label={
                      session.isIdle ? t("queueRunNowSteeringIdle") : t("queueRunNowSteeringBusy")
                    }
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() => void runNow("steering", index)}
                  >
                    <Play size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("queueRemove")}
                    aria-label={t("queueRemove")}
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() =>
                      void applyQueue(
                        steering.filter((_, i) => i !== index),
                        [...followUp],
                      )
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            ),
          )}
          {followUp.map((text, index) =>
            editRow("followUp", index) ?? (
              <li
                key={`fu:${index}`}
                className="group flex items-start gap-2 rounded px-1.5 py-1 hover:bg-surface-overlay/50"
              >
                <span className="mt-1 size-1 shrink-0 rounded-full bg-muted" />
                <QueueText raw={text} />
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title={t("queueMoveUp")}
                    aria-label={t("queueMoveUp")}
                    className={itemButton}
                    disabled={busyOp || index === 0}
                    onClick={() => {
                      const next = [...followUp];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      void applyQueue([...steering], next);
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("queueEdit")}
                    aria-label={t("queueEdit")}
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() => startEdit("followUp", index, text)}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("queueRunNow")}
                    aria-label={t("queueRunNow")}
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() => void runNow("followUp", index)}
                  >
                    <Play size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("queueRemove")}
                    aria-label={t("queueRemove")}
                    className={itemButton}
                    disabled={busyOp}
                    onClick={() =>
                      void applyQueue(
                        [...steering],
                        followUp.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
