import { hostClient } from "../../lib/bridge/host-client";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { notifyOperationFailure } from "../../lib/notify-operation-error";
import { useAppStore } from "../../lib/stores/app-store";
import { type Translate } from "../../lib/i18n/use-t";

/**
 * Rewire the active session's leaf to `targetId`. Returns true when the
 * transcript can act on the result (scroll or applied navigation), false when
 * the request was silently skipped (no session, busy, stale, superseded).
 * Errors surface as notifications, matching the tree overlay's behavior.
 */
export async function navigateTreeTo(targetId: string, t: Translate): Promise<boolean> {
  const current = useAppStore.getState();
  if (!current.host || !current.workspace || !current.session) return false;
  if (!current.session.isIdle) return false;
  const generation = captureRequestGeneration(current.host);
  try {
    const res = await requestWithRetry(() =>
      hostClient.request(
        "agent.navigateTree",
        activeSessionContext(current.host!, current.workspace!, current.session!),
        { targetId },
      ),
    );
    if (!res) return false;
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!res.ok) {
      current.pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
      return false;
    }
    if (res.result.cancelled) {
      current.pushNotification(t("dockTreeSwitchCancelled"), "info");
      return false;
    }
    useAppStore.getState().applySessionSnapshot(res.result.session);
    useAppStore.getState().setSessionTreeNavigated(true);
    return true;
  } catch (err) {
    notifyOperationFailure(err, t("dockTreeSwitchFailed"));
    return false;
  }
}
