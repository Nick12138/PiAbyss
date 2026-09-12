import { useEffect, useSyncExternalStore } from "react";
import type { SerializableSessionTreeNode } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { userErrorMessage } from "../../lib/notify-operation-error";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";

/**
 * Shared session-tree state. The tree is read through one `session.getTree`
 * RPC (which briefly takes the Host's service graph lock), so the overlay and
 * the inline branch navigators consume this single store instead of each
 * fetching on their own.
 */
type SessionTreeState = {
  /** Session the current tree belongs to; stale trees are dropped on switch. */
  sessionId: string | null;
  tree: SerializableSessionTreeNode[] | null;
  leafId: string | null;
  /** Localized load error, null when the tree loaded (or is loading). */
  error: string | null;
  /** Manual-refresh counter bumped by the overlay's refresh button. */
  refreshSeq: number;
};

let state: SessionTreeState = {
  sessionId: null,
  tree: null,
  leafId: null,
  error: null,
  refreshSeq: 0,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setSessionTree(next: Partial<SessionTreeState>): void {
  state = { ...state, ...next };
  emit();
}

function subscribeSessionTree(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSessionTree(): SessionTreeState {
  return state;
}

/** React binding for consumers: the overlay and the inline navigators. */
export function useSessionTree(): SessionTreeState {
  return useSyncExternalStore(subscribeSessionTree, getSessionTree);
}

/** Ask the sync effect to refetch (overlay refresh button). */
export function refreshSessionTree(): void {
  setSessionTree({ refreshSeq: state.refreshSeq + 1 });
}

/**
 * Keep the shared store in sync with the Host. Mounted once per chat page:
 * refetches on identity changes, busy edges (a run settled — the only moment
 * the tree's branch structure can change), navigation, and manual refresh.
 * Per-message cadence is deliberately avoided: every read takes the Host's
 * service graph lock, and a per-message cadence starves session switches and
 * navigation with SERVICE_GRAPH_BUSY.
 */
export function useSessionTreeSync(): void {
  const t = useT();
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId);
  const workspaceId = useAppStore((s) => s.workspace?.id);
  const workspaceRevision = useAppStore((s) => s.workspace?.revision);
  const sessionId = useAppStore((s) => s.session?.sessionId);
  const sessionRevision = useAppStore((s) => s.session?.revision);
  // Busy edge: true→false (a run settled) triggers a refetch so a finished
  // run's new branches show up; true→true streaming frames do not.
  const busy = useAppStore((s) => (s.session ? !s.session.isIdle : false));
  // Only the manual-refresh counter is reactive here: subscribing to the whole
  // store would re-render the chat page (and the transcript) on every fetch.
  const refreshSeq = useSyncExternalStore(subscribeSessionTree, () => state.refreshSeq);

  useEffect(() => {
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) {
      setSessionTree({ sessionId: null, tree: null, leafId: null, error: null });
      return;
    }
    let cancelled = false;
    // Drop a tree from the previous session immediately; navigation and the
    // inline navigators must never act on another session's branches.
    if (getSessionTree().sessionId !== current.session.sessionId) {
      setSessionTree({
        sessionId: current.session.sessionId,
        tree: null,
        leafId: null,
        error: null,
      });
    }
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
          setSessionTree({ error: localizeHostError(res.error, t) });
          return;
        }
        setSessionTree({ tree: res.result.tree, leafId: res.result.leafId, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setSessionTree({ error: userErrorMessage(err, t("dockTreeLoadFailed")) });
      });
    return () => {
      cancelled = true;
    };
  }, [
    hostInstanceId,
    workspaceId,
    workspaceRevision,
    sessionId,
    sessionRevision,
    busy,
    refreshSeq,
    t,
  ]);
}

/** Test helper: drop cached tree state between renders. */
export function __resetSessionTreeForTest(): void {
  state = { sessionId: null, tree: null, leafId: null, error: null, refreshSeq: 0 };
  emit();
}
