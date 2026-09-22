import { hostClient } from "../bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../bridge/localize-host-error";
import { requestWithRetry } from "../bridge/request-retry";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
} from "../bridge/host-context";
import { tCurrent } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";

let createPending = false;
const createPendingListeners = new Set<(pending: boolean) => void>();

function setCreatePending(pending: boolean): void {
  createPending = pending;
  for (const listener of createPendingListeners) listener(pending);
}

export function isCreateSessionPending(): boolean {
  return createPending;
}

export function subscribeCreateSessionPending(listener: (pending: boolean) => void): () => void {
  createPendingListeners.add(listener);
  return () => createPendingListeners.delete(listener);
}

export type AbortMethod = "agent.abort" | "agent.abortCompaction" | "agent.abortRetry";

/**
 * session.create 的 SERVICE_GRAPH_BUSY 退避（总窗口 ≈4.7s）。
 * 首次跨工作区切换（workspace.setCurrent 返回成功）后，目标工作区图常有
 * 短暂的后台收尾（扩展激活、指纹核对）仍占用 serviceGraphLock；紧跟着的
 * session.create 会撞忙。session.open 已有同款退避，这里补齐，否则备忘录
 * 「执行」这类「切换后立即建会话」的路径首跳会误报「服务繁忙」。
 */
const CREATE_SESSION_RETRY_DELAYS_MS = [80, 200, 400, 800, 1200, 2000] as const;

export function abortMethodForSession(session: {
  isCompacting?: boolean;
  isRetrying?: boolean;
}): AbortMethod {
  if (session.isCompacting) return "agent.abortCompaction";
  if (session.isRetrying) return "agent.abortRetry";
  return "agent.abort";
}

export async function createNewSession(): Promise<boolean> {
  const state = useAppStore.getState();
  if (!state.host || !state.workspace?.servicesReady || createPending) return false;
  const generation = captureRequestGeneration(state.host);
  setCreatePending(true);
  try {
    const response = await requestWithRetry(
      () => {
        // 每次尝试都取最新的身份上下文（重试窗口内 host/workspace 理论上
        // 不变，但快照可能已被事件流更新——与 session.open 的做法一致）。
        const current = useAppStore.getState();
        if (!current.host || !current.workspace) {
          throw new Error(tCurrent("notifCreateSessionFailed"));
        }
        return hostClient.request(
          "session.create",
          nullableSessionContext(current.host, current.workspace),
          {},
        );
      },
      undefined,
      () => isCurrentRequestGeneration(useAppStore.getState().host, generation),
      CREATE_SESSION_RETRY_DELAYS_MS,
    );
    if (!response) return false;
    if (!isCurrentRequestGeneration(useAppStore.getState().host, generation)) {
      return false;
    }
    if (!response.ok) {
      useAppStore
        .getState()
        .pushNotification(
          localizeHostError(response.error, tCurrent),
          hostErrorLevel(response.error),
        );
      return false;
    }
    const current = useAppStore.getState();
    current.applySessionSnapshot(response.result);
    if (current.host) {
      const nextHost = mergeHostIdentity(current.host, response);
      if (nextHost) current.setHost(nextHost);
    }
    return true;
  } catch (error) {
    useAppStore
      .getState()
      .pushNotification(
        error instanceof Error ? error.message : tCurrent("notifCreateSessionFailed"),
        "error",
      );
    return false;
  } finally {
    setCreatePending(false);
  }
}

export async function abortCurrentAgent(): Promise<boolean> {
  const state = useAppStore.getState();
  if (!state.host || !state.workspace || !state.session || state.session.isIdle) {
    return false;
  }
  const generation = captureRequestGeneration(state.host);
  try {
    const method = abortMethodForSession(state.session);
    if (method !== "agent.abort") {
      const response = await hostClient.request(
        method,
        activeSessionContext(state.host, state.workspace, state.session),
        null,
      );
      if (
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return false;
      }
      if (!response.ok) {
        useAppStore
          .getState()
          .pushNotification(
            response.error?.message ??
              tCurrent(
                method === "agent.abortCompaction"
                  ? "notifCompactStopFailed"
                  : "composerAbortFailed",
              ),
            "error",
          );
        return false;
      }
      return true;
    }
    const response = await hostClient.request(
      "agent.abort",
      activeSessionContext(state.host, state.workspace, state.session),
      null,
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!response.ok) {
      useAppStore
        .getState()
        .pushNotification(
          localizeHostError(response.error, tCurrent),
          hostErrorLevel(response.error),
        );
      return false;
    }
    useAppStore.getState().applySessionSnapshot(response.result.session);
    if (response.result.error) {
      useAppStore.getState().pushNotification(response.result.error.message, "error");
    }
    return true;
  } catch (error) {
    useAppStore
      .getState()
      .pushNotification(
        error instanceof Error ? error.message : tCurrent("composerAbortFailed"),
        "error",
      );
    return false;
  }
}
