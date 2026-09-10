import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
  mergeHostIdentity,
} from "./bridge/host-context";
import { SESSION_OPEN_TIMEOUT_MS } from "./bridge/session-open-request";
import { requestWithRetry } from "./bridge/request-retry";
import { tCurrent } from "./i18n/use-t";
import { notifyOperationFailure } from "./notify-operation-error";
import { hostErrorLevel, localizeHostError } from "./bridge/localize-host-error";
import { editDraft } from "./draft-persistence";
import { draftTargetFor } from "./draft-target";

/**
 * Fork the active session and switch to the forked session. The default
 * position ("before") branches before the given user message and restores
 * its text into the composer; "at" keeps history through the given entry —
 * forking from the end of an assistant turn. Returns true when the fork
 * was applied.
 */
export async function requestFork(
  entryId: string,
  options: { position?: "before" | "at" } = {},
): Promise<boolean> {
  const { host, workspace, session, pushNotification, applySessionSnapshot } =
    useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification(tCurrent("notifForkWait"), "info");
    return false;
  }
  const generation = captureRequestGeneration(host);
  try {
    // Fork ends in the session-open flow, so it shares its generous timeout.
    const res = await requestWithRetry(() =>
      hostClient.request(
        "session.fork",
        activeSessionContext(host, workspace, session),
        { entryId, ...(options.position ? { position: options.position } : {}) },
        SESSION_OPEN_TIMEOUT_MS,
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
      pushNotification(
        res.error ? localizeHostError(res.error, tCurrent) : tCurrent("notifForkFailed"),
        hostErrorLevel(res.error),
      );
      return false;
    }
    applySessionSnapshot(res.result.session);
    const latestHost = useAppStore.getState().host;
    if (latestHost) {
      const nextHost = mergeHostIdentity(latestHost, res);
      if (nextHost) useAppStore.getState().setHost(nextHost);
    }
    if (res.result.selectedText !== undefined) {
      const target = draftTargetFor(workspace, res.result.session);
      if (target) editDraft(target, res.result.selectedText);
    }
    pushNotification(tCurrent("notifForked"), "info");
    return true;
  } catch (error) {
    notifyOperationFailure(error, tCurrent("notifForkFailed"));
    return false;
  }
}
