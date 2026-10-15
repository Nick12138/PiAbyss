import type { JsonValue } from "@piabyss/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { hostClient, isHostEpochError } from "../../lib/bridge/host-client";
import { latestSessionTargetContext } from "../../lib/bridge/host-context";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import {
  type ExtensionDecisionStepOutcome,
  isExtensionUiRequestExpired,
  type ExtensionUiRequestState,
} from "../../lib/stores/extension-ui-state";

export type ExtensionUiResponseController = {
  input: string;
  setInput: (value: string) => void;
  submitting: boolean;
  error: string | null;
  respond: (status: "resolved" | "cancelled", value?: JsonValue) => Promise<boolean>;
};

export function useExtensionUiResponse(
  request: ExtensionUiRequestState | null,
): ExtensionUiResponseController {
  const t = useT();
  const closeRequest = useAppStore((state) => state.closeExtensionUiRequest);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [input, setInputState] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;

  /**
   * Remove a settled request from wherever it lives — active slot or queue.
   *
   * A session switch while the respond RPC is in flight demotes the request
   * from the active slot into the queue (`alignExtensionUiToSession`). If we
   * only closed it when it was still active, the settled request would stay
   * queued forever and later be promoted back — the questionnaire card would
   * "rewind" to a question the user already answered. `closeRequest` is a
   * no-op when the requestId is nowhere, so calling it unconditionally is
   * safe; the return value says whether the request was found at all.
   */
  const settleRequest = useCallback(
    (requestId: string, outcome: ExtensionDecisionStepOutcome): boolean => {
      const state = useAppStore.getState();
      const wasActive = state.extensionUiRequest?.requestId === requestId;
      const wasQueued = state.extensionUiQueue.some((queued) => queued.requestId === requestId);
      if (!wasActive && !wasQueued) return false;
      closeRequest(requestId, outcome);
      return true;
    },
    [closeRequest],
  );

  useEffect(() => {
    submittingRef.current = false;
    setSubmitting(false);
    setError(null);
    /**
     * A card that shows a choice list (a single-select, or a questionnaire's
     * multi-select) owns its own field: telling a restored *selection* (an option
     * id, or a `"1,3"` position list) from a restored *free-text* answer needs the
     * option list, which only that card has. Seeding here would blank a rewound
     * typed answer — the card restores it, then this effect runs afterwards
     * (children flush before their parent) and wipes it.
     */
    if (request?.kind === "select" || request?.multiSelect === true) return;
    // Only the free-text kinds seed their field from `defaultValue`.
    const seedsField = request?.kind === "input" || request?.kind === "editor";
    setInputState(seedsField ? (request?.defaultValue ?? "") : "");
  }, [request?.requestId, request?.defaultValue, request?.kind, request?.multiSelect]);

  useEffect(() => {
    if (!request?.expiresAt) return;
    const requestId = request.requestId;
    const timer = window.setTimeout(
      () => {
        if (!settleRequest(requestId, "expired")) return;
        pushNotification(t("extUiExpired"), "warning");
      },
      Math.max(0, request.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [request?.requestId, request?.expiresAt, settleRequest, pushNotification, t]);

  const respond = useCallback(
    async (status: "resolved" | "cancelled", value?: JsonValue): Promise<boolean> => {
      if (!request || submittingRef.current) return false;
      if (isExtensionUiRequestExpired(request)) {
        if (settleRequest(request.requestId, "expired")) {
          pushNotification(t("extUiExpired"), "warning");
        }
        return false;
      }

      const requestId = request.requestId;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const state = useAppStore.getState();
        const response = await hostClient.request(
          "extensionUi.respond",
          latestSessionTargetContext(request.context, state.host, state.workspace, state.session),
          { requestId, status, value },
        );
        if (!response.ok) {
          // STALE_REVISION means the Host no longer knows this requestId — it
          // was settled by another path (session rebuild, identity migration,
          // disposal). Keeping the card on screen as "pending" would strand the
          // user on a zombie request, so settle it locally and drop the card.
          if (response.error?.code === "STALE_REVISION") {
            settleRequest(requestId, "stale");
            return false;
          }
          const message = response.error?.message ?? t("extUiRespondFailed");
          if (useAppStore.getState().extensionUiRequest?.requestId === requestId) {
            setError(message);
            pushNotification(message, "error");
          }
          return false;
        }
        settleRequest(requestId, status === "resolved" ? "answered" : "cancelled");
        return true;
      } catch (caught) {
        // Host-epoch rejections abort the respond call with an internal
        // reason; the replayed request restores a fresh panel on recovery.
        if (isHostEpochError(caught)) return false;
        const message = caught instanceof Error ? caught.message : t("extUiRespondFailed");
        if (useAppStore.getState().extensionUiRequest?.requestId === requestId) {
          setError(message);
          pushNotification(message, "error");
        }
        return false;
      } finally {
        if (requestRef.current?.requestId === requestId) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    },
    [request, settleRequest, pushNotification, t],
  );

  const setInput = useCallback((value: string) => {
    setInputState(value);
    setError(null);
  }, []);

  return { input, setInput, submitting, error, respond };
}
