import type { JsonValue, SerializableImage } from "@piabyss/protocol";
import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import { activeSessionContext } from "./bridge/host-context";
import { hostErrorLevel, localizeHostError } from "./bridge/localize-host-error";
import { tCurrent } from "./i18n/use-t";
import {
  appendOptimisticUserMessage,
  removeOptimisticUserMessage,
} from "./chat/optimistic-echo";
import {
  buildAttachedFileBlock,
  buildAttachedPathBlock,
  parseUserAttachments,
  type TranscriptRow,
} from "../features/chat/transcript-model";

type ActiveSessionPromptParams = {
  text: string;
  images?: SerializableImage[];
  attachmentIds?: string[];
};

// The optimistic bubble must carry the exact outgoing text (including
// attachment reference blocks) so the reducer's message_start expansion
// in-place match succeeds; the bubble renderer strips those blocks for
// display anyway.

/**
 * Send a prompt to the active session, applying the shared safeguards: the
 * agent must be idle, AUTH_REQUIRED opens the auth banner instead of a toast,
 * other failures surface as notifications. Returns true when the prompt was
 * accepted.
 */
async function promptActiveSession(params: ActiveSessionPromptParams): Promise<boolean> {
  const { host, workspace, session, pushNotification, setAuthBlocked } = useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification(tCurrent("notifRetryWait"), "info");
    return false;
  }

  const handleFailure = (
    error: { code: string; message: string; details?: JsonValue } | undefined,
  ) => {
    if (error?.code === "AUTH_REQUIRED") {
      const details = error.details;
      setAuthBlocked({
        providerId:
          details && typeof details === "object" && !Array.isArray(details)
            ? typeof details.providerId === "string"
              ? details.providerId
              : null
            : null,
      });
    } else {
      pushNotification(localizeHostError(error, tCurrent), hostErrorLevel(error));
    }
  };

  // Same optimistic echo as the Composer: the retry/Go On bubble should show
  // immediately, not after the Host's message_start clears preflight. A
  // rejected send rolls the bubble back.
  const optimisticKey = appendOptimisticUserMessage(
    params.text,
    session.sessionId,
    params.images,
  );
  try {
    const res = await hostClient.request(
      "agent.prompt",
      activeSessionContext(host, workspace, session),
      params,
      null,
    );
    if (!res.ok) {
      removeOptimisticUserMessage(optimisticKey);
      handleFailure(res.error);
      return false;
    }
    setAuthBlocked(null);
    return true;
  } catch (error) {
    removeOptimisticUserMessage(optimisticKey);
    pushNotification(
      error instanceof Error ? error.message : tCurrent("composerSendFailed"),
      "error",
    );
    return false;
  }
}

/**
 * Re-send a user message after its answer failed or was aborted. Rebuilds the
 * exact prompt (text, text-file attachments, documents, images) and prompts
 * the active session — so the retry runs against whichever model is currently
 * selected, letting the user switch models before retrying. Returns true when
 * the prompt was accepted; the caller hides the failed bubble on success.
 */
export async function requestRetry(row: TranscriptRow): Promise<boolean> {
  const parsed = parseUserAttachments(row.copyText);
  const outgoingText = parsed.files.reduce((text, file) => {
    const block = file.pathOnly
      ? buildAttachedPathBlock(file.name, file.path ?? "")
      : buildAttachedFileBlock(file.name, file.content, file.path);
    return `${text}${text ? "\n\n" : ""}${block}`;
  }, parsed.text);
  const images: SerializableImage[] = row.blocks.flatMap((block) =>
    block.kind === "image" ? [{ mediaType: block.mimeType, data: block.data }] : [],
  );
  const imageParams = images.length > 0 ? { images } : {};
  const attachmentParams =
    parsed.documents.length > 0
      ? { attachmentIds: parsed.documents.map((document) => document.id) }
      : {};

  return promptActiveSession({ text: outgoingText, ...imageParams, ...attachmentParams });
}

/**
 * "Go On": send a bare "Continue" message so the agent resumes the turn that
 * failed or was stopped. Unlike retry, nothing is rebuilt or hidden — the
 * failed answer stays in the transcript and the new turn appends after it.
 */
export async function requestGoOn(): Promise<boolean> {
  return promptActiveSession({ text: "Continue" });
}
