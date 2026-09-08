import type { SerializableImage } from "@piabyss/protocol";
import { useAppStore } from "../stores/app-store";

/**
 * Optimistic user-message echo shared by Composer.send and the retry/Go On
 * actions: show the user's bubble immediately instead of waiting for the Host
 * to echo message_start (which can lag behind model preflight/compaction).
 * The authoritative event later replaces the marker in place, so there is
 * never a duplicate row.
 *
 * Call removeOptimisticUserMessage when the send is rejected so the bubble
 * does not linger for a prompt that never started.
 */

export function appendOptimisticUserMessage(
  text: string,
  expectedSessionId?: string | null,
  images?: readonly SerializableImage[],
): string | null {
  const store = useAppStore.getState();
  const session = store.session;
  if (!session) return null;
  if (expectedSessionId && session.sessionId !== expectedSessionId) return null;
  const key = crypto.randomUUID();
  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...(images ?? []).map((image) => ({
      type: "image" as const,
      mimeType: image.mediaType,
      data: image.data,
    })),
  ];
  const messageContent = images?.length ? content : text;
  store.applySessionSnapshot({
    ...session,
    messages: [
      ...session.messages,
      {
        role: "user",
        content: messageContent,
        timestamp: Date.now(),
        _optimisticKey: key,
      },
    ],
  });
  return key;
}

export function removeOptimisticUserMessage(key: string | null): void {
  if (!key) return;
  const store = useAppStore.getState();
  const session = store.session;
  if (!session) return;
  if (!session.messages.some((message) => message._optimisticKey === key)) return;
  useAppStore.setState({
    session: {
      ...session,
      messages: session.messages.filter((message) => message._optimisticKey !== key),
    },
  });
}
