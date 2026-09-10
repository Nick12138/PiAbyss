import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";
import { tCurrent } from "../../lib/i18n/use-t";
import { notifyOperationFailure } from "../../lib/notify-operation-error";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";

/** Manually compact the active session's context. Surfaces the outcome
 * through notifications; returns true when compaction succeeded. */
export async function requestCompact(instructions?: string): Promise<boolean> {
  const { host, workspace, session, pushNotification, applySessionSnapshot } =
    useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification(tCurrent("notifCompactWait"), "info");
    return false;
  }
  const generation = captureRequestGeneration(host);
  try {
    // Compaction summarizes with an LLM call, so like agent.prompt it gets
    // no client-side timeout.
    const res = await hostClient.request(
      "agent.compact",
      activeSessionContext(host, workspace, session),
      instructions ? { instructions } : null,
      null,
    );
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!res.ok) {
      pushNotification(
        res.error ? localizeHostError(res.error, tCurrent) : tCurrent("notifCompactFailed"),
        hostErrorLevel(res.error),
      );
      return false;
    }
    applySessionSnapshot(res.result.session);
    const { tokensBefore } = res.result.result;
    // The SDK reports estimatedTokensAfter; the protocol type also allows an
    // exact tokensAfter.
    const tokensAfter = res.result.result.tokensAfter ?? res.result.result.estimatedTokensAfter;
    pushNotification(
      typeof tokensBefore === "number" && typeof tokensAfter === "number"
        ? tCurrent("notifCompacted", {
            before: formatTokenCount(tokensBefore),
            after: formatTokenCount(tokensAfter),
          })
        : tCurrent("notifCompactedPlain"),
      "info",
    );
    return true;
  } catch (error) {
    notifyOperationFailure(error, tCurrent("notifCompactFailed"));
    return false;
  }
}

/** Stop an in-flight compaction (manual or auto). */
export async function abortCompaction(): Promise<void> {
  const { host, workspace, session, pushNotification } = useAppStore.getState();
  if (!host || !workspace || !session) return;
  const res = await hostClient.request(
    "agent.abortCompaction",
    activeSessionContext(host, workspace, session),
    null,
  );
  if (!res.ok) {
    pushNotification(
      res.error ? localizeHostError(res.error, tCurrent) : tCurrent("notifCompactStopFailed"),
      hostErrorLevel(res.error),
    );
  }
}

/** Toggle auto-compaction for the active session. */
export async function setAutoCompaction(enabled: boolean): Promise<void> {
  const { host, workspace, session, pushNotification, applySessionSnapshot } =
    useAppStore.getState();
  if (!host || !workspace || !session) return;
  const generation = captureRequestGeneration(host);
  const res = await hostClient.request(
    "agent.setAutoCompaction",
    activeSessionContext(host, workspace, session),
    { enabled },
  );
  if (
    !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
      session: true,
    })
  ) {
    return;
  }
  if (!res.ok) {
    pushNotification(
      res.error
        ? localizeHostError(res.error, tCurrent)
        : tCurrent("notifAutoCompactionFailed"),
      hostErrorLevel(res.error),
    );
    return;
  }
  applySessionSnapshot(res.result);
}
