import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, GitFork, LoaderCircle, RefreshCw } from "lucide-react";
import type { SerializableSessionTreeNode } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { requestFork } from "../../lib/fork-actions";
import { requestTranscriptScroll } from "../../lib/transcript-navigation";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { notifyOperationFailure, userErrorMessage } from "../../lib/notify-operation-error";
import { useT } from "../../lib/i18n/use-t";
import { flattenSessionTree, type TreeRow } from "./tree-model";

const ROW_H = 28;
const LANE_W = 14;
const ACCENT = "var(--color-accent)";
const BASE = "var(--color-border)";
/** Estimated average glyph width (px) at the row's 12px font, used to budget
 *  the excerpt length from the available panel width. CSS ellipsis still
 *  applies the exact pixel-level cutoff. */
const CHAR_W = 7;

function laneX(lane: number): number {
  return lane * LANE_W + 7;
}

/** Commit-graph gutter for one fixed-height row. */
function RowRail({ row, laneCount }: { row: TreeRow; laneCount: number }) {
  const x = laneX(row.lane);
  const mid = ROW_H / 2;
  const stroke = (accent: boolean) => (accent ? ACCENT : BASE);
  return (
    <svg width={laneCount * LANE_W + 2} height={ROW_H} className="shrink-0" aria-hidden="true">
      {row.passes.map((pass) => (
        <line
          key={`pass:${pass.lane}`}
          x1={laneX(pass.lane)}
          y1={0}
          x2={laneX(pass.lane)}
          y2={ROW_H}
          stroke={stroke(pass.accent)}
          strokeWidth={1.5}
        />
      ))}
      {row.linkUp && (
        <line x1={x} y1={0} x2={x} y2={mid} stroke={stroke(row.linkUpAccent)} strokeWidth={1.5} />
      )}
      {row.linkDown && (
        <line
          x1={x}
          y1={mid}
          x2={x}
          y2={ROW_H}
          stroke={stroke(row.linkDownAccent)}
          strokeWidth={1.5}
        />
      )}
      {row.forks.map((fork) => (
        <path
          key={`fork:${fork.lane}`}
          d={`M ${x} ${mid} C ${x} ${ROW_H}, ${laneX(fork.lane)} ${mid}, ${laneX(fork.lane)} ${ROW_H}`}
          fill="none"
          stroke={stroke(fork.accent)}
          strokeWidth={1.5}
        />
      ))}
      {row.kind === "user" ? (
        <circle cx={x} cy={mid} r={4} fill={row.onPath ? ACCENT : "var(--color-muted)"} />
      ) : (
        <circle
          cx={x}
          cy={mid}
          r={3.5}
          fill="var(--color-sidebar)"
          stroke={row.onPath ? ACCENT : "var(--color-muted)"}
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

export function TreePanel({ visible }: { visible: boolean }) {
  const t = useT();
  const session = useAppStore((state) => state.session);
  const applySessionSnapshot = useAppStore((state) => state.applySessionSnapshot);
  const setSessionTreeNavigated = useAppStore((state) => state.setSessionTreeNavigated);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [nodes, setNodes] = useState<SerializableSessionTreeNode[] | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  // Width available to the text column drives the excerpt char budget so the
  // displayed message length tracks the panel size.
  const panelRef = useRef<HTMLDivElement>(null);
  const [textWidth, setTextWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const update = () => {
      setTextWidth((width) =>
        Math.abs((width ?? 0) - element.clientWidth) > 1 ? element.clientWidth : width,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const hostInstanceId = useAppStore((state) => state.host?.hostInstanceId);
  const workspaceId = useAppStore((state) => state.workspace?.id);
  const workspaceRevision = useAppStore((state) => state.workspace?.revision);
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;
  const busy = session ? !session.isIdle : true;

  // Refetch on identity changes, busy edges (run settled), navigation, and
  // manual refresh — NOT per streamed message: every read briefly takes the
  // Host's service graph lock, and a per-message cadence starves session
  // switches and navigation with SERVICE_GRAPH_BUSY.
  useEffect(() => {
    if (!visible) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) {
      setNodes(null);
      setLeafId(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    const generation = captureRequestGeneration(current.host);
    void requestWithRetry(
      () =>
        hostClient.request(
          "session.getTree",
          activeSessionContext(current.host!, current.workspace!, current.session!),
          null,
        ),
      undefined,
      () => !cancelled,
    )
      .then((res) => {
        if (cancelled || !res) return;
        if (
          !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
            session: true,
          })
        ) {
          return;
        }
        if (!res.ok) {
          setError(localizeHostError(res.error, t));
          return;
        }
        setNodes(res.result.tree);
        setLeafId(res.result.leafId);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(userErrorMessage(err, t("dockTreeLoadFailed")));
      });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    hostInstanceId,
    workspaceId,
    workspaceRevision,
    sessionId,
    sessionRevision,
    busy,
    refreshSeq,
    t,
  ]);

  // The tree belongs to the active session; drop it when the session changes.
  useEffect(() => {
    setNodes(null);
    setLeafId(null);
    setNavigating(null);
    setForking(null);
  }, [sessionId]);

  // Prefer positioning the transcript at the clicked message; only rewire the
  // session leaf when the message isn't rendered on the current path (off-branch).
  function onRowActivate(targetId: string) {
    if (requestTranscriptScroll({ sourceId: targetId })) return;
    void navigate(targetId);
  }

  async function navigate(targetId: string) {
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) return;
    if (!current.session.isIdle || navigating) return;
    setNavigating(targetId);
    const generation = captureRequestGeneration(current.host);
    try {
      const res = await requestWithRetry(() =>
        hostClient.request(
          "agent.navigateTree",
          activeSessionContext(current.host!, current.workspace!, current.session!),
          { targetId },
        ),
      );
      if (!res) return;
      if (
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
        return;
      }
      if (res.result.cancelled) {
        pushNotification(t("dockTreeSwitchCancelled"), "info");
        return;
      }
      applySessionSnapshot(res.result.session);
      setSessionTreeNavigated(true);
      setRefreshSeq((seq) => seq + 1);
    } catch (err) {
      notifyOperationFailure(err, t("dockTreeSwitchFailed"));
    } finally {
      setNavigating(null);
    }
  }

  const { rows, laneCount } = useMemo(() => {
    if (!nodes) return { rows: [], laneCount: 1 };
    const maxChars = textWidth !== null ? Math.max(12, Math.floor(textWidth / CHAR_W)) : undefined;
    return flattenSessionTree(nodes, leafId, maxChars);
  }, [nodes, leafId, textWidth]);

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted">
        {t("dockTreeNoSession")}
      </div>
    );
  }

  const firstUserId = rows.find((row) => row.kind === "user")?.id;

  return (
    <div ref={panelRef} className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <div className="interface-density-nav-row flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <GitBranch size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {busy ? t("dockTreeBusy") : t("dockTreeHint")}
        </span>
        <button
          type="button"
          title={t("dockTreeRefresh")}
          aria-label={t("dockTreeRefresh")}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={() => setRefreshSeq((seq) => seq + 1)}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error ? (
          <p className="px-3 py-2 text-xs text-danger">{error}</p>
        ) : nodes === null ? (
          <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
            <LoaderCircle size={12} className="animate-spin" /> {t("dockTreeLoading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted">{t("dockTreeEmpty")}</p>
        ) : (
          rows.map((row) => {
            const actionLocked = busy || navigating !== null || forking !== null;
            return (
              <div
                key={row.id}
                className={`group flex min-w-0 max-w-full h-7 items-stretch overflow-hidden pl-2 ${
                  row.isCurrent ? "bg-surface-overlay/60" : "hover:bg-surface-overlay/40"
                }`}
              >
                <RowRail row={row} laneCount={laneCount} />
                <button
                  type="button"
                  disabled={actionLocked}
                  aria-current={row.isCurrent ? "true" : undefined}
                  title={row.excerpt}
                  className={`flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden pl-1 text-left text-xs ${
                    row.onPath ? "text-foreground" : "text-muted"
                  } disabled:cursor-default`}
                  onClick={() => void onRowActivate(row.id)}
                >
                  {(navigating === row.id || forking === row.id) && (
                    <LoaderCircle size={12} className="shrink-0 animate-spin" />
                  )}
                  <span
                    className={`min-w-0 max-w-full flex-1 truncate overflow-hidden text-ellipsis whitespace-nowrap ${
                      row.kind === "user" ? "font-medium" : ""
                    }`}
                  >
                    {row.excerpt}
                  </span>
                  {row.label && (
                    <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-muted">
                      {row.label}
                    </span>
                  )}
                  {row.isCurrent && (
                    <span className="mx-[5px] shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                      {t("dockTreeCurrent")}
                    </span>
                  )}
                </button>
                {row.kind === "user" && row.id !== firstUserId && (
                  <button
                    type="button"
                    disabled={actionLocked}
                    title={t("dockTreeFork")}
                    aria-label={t("dockTreeForkFrom", { excerpt: row.excerpt })}
                    className="mx-[5px] flex shrink-0 items-center justify-center px-2 text-muted hover:text-foreground disabled:opacity-40"
                    onClick={() => {
                      setForking(row.id);
                      void requestFork(row.id).finally(() => setForking(null));
                    }}
                  >
                    <GitFork size={12} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
