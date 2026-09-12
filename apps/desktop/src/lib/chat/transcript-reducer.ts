/**
 * Apply Host agent.event payloads onto the local SessionSnapshot projection.
 * Pi remains the fact source — this only streams UI until the next full snapshot.
 */
import type {
  JsonValue,
  SerializableAgentContent,
  SerializableSessionEntry,
  SessionSnapshot,
  SerializableAgentMessage,
  SerializableAssistantMessageEvent,
  HostIdentity,
} from "@piabyss/protocol";
import { toJsonValue, stripAttachmentReferenceBlocks } from "@piabyss/protocol";
import { parse as parsePartialJson } from "partial-json";
import { isAbortedToolResult } from "./tool-result-status";

type ToolExecutionPart = {
  type: "toolCall";
  id: string;
  name: string;
  text: string;
  status: "running" | "done" | "error" | "aborted";
  arguments?: string;
  result?: string;
  resultBlocks?: JsonValue[];
  details?: JsonValue;
  startedAt: number;
  endedAt?: number;
};

export type AgentEventEnvelope = {
  runId?: string;
  event: {
    type?: string;
    message?: SerializableAgentMessage | { role?: string; content?: unknown };
    delta?: unknown;
    assistantMessageEvent?: SerializableAssistantMessageEvent;
    toolCall?: { name?: string; arguments?: unknown; id?: string };
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    partialResult?: unknown;
    toolResult?: unknown;
    result?: unknown;
    isError?: boolean;
    error?: unknown;
    [key: string]: unknown;
  };
};

export type TimedAgentEventEnvelope = HostIdentity & {
  sequence: number;
  payload: AgentEventEnvelope;
  receivedAt: number;
};

export function matchesTimedAgentEventIdentity(
  event: TimedAgentEventEnvelope,
  identity: HostIdentity,
): boolean {
  return (
    event.hostInstanceId === identity.hostInstanceId &&
    event.workspaceId === identity.workspaceId &&
    event.workspaceRevision === identity.workspaceRevision &&
    event.sessionId === identity.sessionId &&
    event.sessionRevision === identity.sessionRevision &&
    event.packageRevision === identity.packageRevision
  );
}

export function applyAgentEventBatch(
  session: SessionSnapshot | null,
  events: TimedAgentEventEnvelope[],
): SessionSnapshot | null {
  if (!session || events.length === 0) return session;
  const next = createSessionDraft(session);
  for (const event of coalesceAgentEventBatch(events)) {
    applyAgentEventToDraft(next, event.payload, event.receivedAt);
  }
  return next;
}

export function coalesceAgentEventBatch(
  events: TimedAgentEventEnvelope[],
): TimedAgentEventEnvelope[] {
  const coalesced: TimedAgentEventEnvelope[] = [];
  let active: {
    first: TimedAgentEventEnvelope;
    latest: TimedAgentEventEnvelope;
    delta: Extract<SerializableAssistantMessageEvent, { delta: string }>;
    chunks: string[];
  } | null = null;

  const flushActive = () => {
    if (!active) return;
    if (active.chunks.length === 1) {
      coalesced.push(active.first);
    } else {
      coalesced.push({
        ...active.latest,
        receivedAt: active.first.receivedAt,
        payload: {
          ...active.latest.payload,
          event: {
            ...active.latest.payload.event,
            assistantMessageEvent: {
              ...active.delta,
              delta: active.chunks.join(""),
            },
          },
        },
      });
    }
    active = null;
  };

  for (const event of events) {
    const currentDelta = assistantDeltaEvent(event);
    if (
      active &&
      currentDelta &&
      sameTimedAgentEventIdentity(active.latest, event) &&
      active.latest.payload.runId === event.payload.runId &&
      active.delta.type === currentDelta.type &&
      active.delta.contentIndex === currentDelta.contentIndex
    ) {
      active.latest = event;
      active.chunks.push(currentDelta.delta);
      continue;
    }
    flushActive();
    if (currentDelta) {
      active = {
        first: event,
        latest: event,
        delta: currentDelta,
        chunks: [currentDelta.delta],
      };
    } else {
      coalesced.push(event);
    }
  }
  flushActive();
  return coalesced;
}

export function applyAgentEvent(
  session: SessionSnapshot | null,
  payload: AgentEventEnvelope,
  eventTime = Date.now(),
): SessionSnapshot | null {
  if (!session) return session;
  const next = createSessionDraft(session);
  applyAgentEventToDraft(next, payload, eventTime);
  return next;
}

function createSessionDraft(session: SessionSnapshot): SessionSnapshot {
  return { ...session, messages: [...session.messages] };
}

function applyAgentEventToDraft(
  next: SessionSnapshot,
  payload: AgentEventEnvelope,
  eventTime: number,
): void {
  const ev = payload.event ?? (payload as unknown as AgentEventEnvelope["event"]);
  if (!ev || typeof ev !== "object") return;

  const type = String(ev.type ?? "");

  switch (type) {
    case "agent_start":
      // A new run starts before its first message. Close any prior runtime tail
      // so the previous assistant row cannot be mistaken for the new stream.
      next.messages = settleOpenRuntime(next.messages, eventTime);
      next.isStreaming = true;
      next.isIdle = false;
      break;
    case "turn_start":
      next.isStreaming = true;
      next.isIdle = false;
      break;

    case "message_start": {
      const msg = normalizeMessage(ev.message);
      if (msg) {
        if (msg.role !== "user" || !replaceOptimisticUserMessageInPlace(next.messages, msg)) {
          next.messages.push(
            msg.role === "assistant"
              ? {
                  ...msg,
                  startedAt: numericField(msg, "startedAt") ?? eventTime,
                  ...(payload.runId ? { _streamRunId: payload.runId } : {}),
                }
              : msg,
          );
        }
      }
      next.isStreaming = true;
      next.isIdle = false;
      break;
    }

    case "message_update": {
      if (ev.assistantMessageEvent) {
        appendAssistantContentEventInPlace(
          next.messages,
          ev.assistantMessageEvent,
          eventTime,
          payload.runId,
        );
      } else {
        const deltaText = extractGenericDelta(ev);
        if (deltaText) appendTextDeltaInPlace(next.messages, deltaText, eventTime, payload.runId);
      }
      next.isStreaming = true;
      next.isIdle = false;
      break;
    }

    case "message_end": {
      const msg = normalizeMessage(ev.message);
      if (msg) {
        if (msg.role === "assistant") {
          mergeLastAssistantInPlace(next.messages, msg, eventTime, true, payload.runId);
        } else if (replaceMatchingUserMessageInPlace(next.messages, msg)) {
          // Authoritative message upgraded/replaced the matching user bubble in place.
        } else {
          const last = next.messages[next.messages.length - 1];
          if (last?.role === msg.role) next.messages[next.messages.length - 1] = msg;
          else next.messages.push(msg);
        }
      }
      break;
    }

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const toolName = String(
        ev.toolName ?? (ev.toolCall as { name?: string } | undefined)?.name ?? "tool",
      );
      const toolCallId = String(
        ev.toolCallId ??
          (ev.toolCall as { id?: string } | undefined)?.id ??
          `${payload.runId ?? "run"}:${toolName}`,
      );
      const existing = findToolExecution(next.messages, toolCallId);
      const ended = type === "tool_execution_end";
      const resultValue = ev.result ?? ev.error;
      const aborted = ended && isAbortedToolResult(resultValue, ev.isError === true);
      const status = ended ? (aborted ? "aborted" : ev.isError ? "error" : "done") : "running";
      const resultProjection = ended
        ? projectToolResult(resultValue)
        : ev.partialResult !== undefined
          ? projectToolResult(ev.partialResult)
          : existing
            ? {
                ...(existing.result !== undefined ? { result: existing.result } : {}),
                ...(existing.resultBlocks !== undefined
                  ? { resultBlocks: existing.resultBlocks }
                  : {}),
                ...(existing.details !== undefined ? { details: existing.details } : {}),
              }
            : {};
      const part: ToolExecutionPart = {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        text: status,
        status,
        arguments: toJsonish(
          ev.args ??
            (ev.toolCall as { arguments?: unknown } | undefined)?.arguments ??
            existing?.arguments ??
            null,
        ),
        ...resultProjection,
        startedAt: existing?.startedAt ?? eventTime,
        ...(ended ? { endedAt: eventTime } : {}),
      };
      upsertToolExecutionInPlace(next.messages, toolCallId, part);
      next.isStreaming = true;
      next.isIdle = false;
      break;
    }

    case "queue_update": {
      const steering = Array.isArray((ev as { steering?: unknown }).steering)
        ? ((ev as { steering: string[] }).steering as string[])
        : next.pending.steering;
      const followUp = Array.isArray((ev as { followUp?: unknown }).followUp)
        ? ((ev as { followUp: string[] }).followUp as string[])
        : next.pending.followUp;
      next.pending = { ...next.pending, steering, followUp };
      break;
    }

    case "entry_appended": {
      const entry = normalizeSessionEntry(ev.entry);
      if (!entry || !next.entries) break;

      // Snapshot entries are the active branch only. Accept a live append when
      // it extends that branch; a branch jump is reconciled by the next full
      // snapshot instead of manufacturing a path in the renderer.
      const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
      if (parentId !== (next.leafId ?? null)) break;
      if (next.entries.some((candidate) => candidate.id === entry.id)) break;
      next.entries = [...next.entries, entry];
      next.leafId = entry.id;
      break;
    }

    case "compaction_start":
      next.isCompacting = true;
      next.isIdle = false;
      break;
    case "compaction_end":
      next.isCompacting = false;
      break;
    case "auto_retry_start":
      next.isRetrying = true;
      next.isIdle = false;
      break;
    case "auto_retry_end":
      next.isRetrying = false;
      break;

    // The summarization call inside compaction or branch-summary can back off
    // and retry on transient stream errors. During compaction the header keeps
    // saying "Compacting" (isCompacting wins); for branch summaries this is the
    // only signal that the session is waiting on a retry, not stuck.
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
      next.isRetrying = true;
      next.isIdle = false;
      break;
    case "summarization_retry_finished":
      next.isRetrying = false;
      break;

    case "agent_end":
      // agent_end closes one core-agent run. Pi may still retry, compact, or
      // process a continuation queued by an extension before agent_settled.
      next.isStreaming = true;
      next.isIdle = false;
      break;

    case "agent_settled":
      next.messages = settleOpenRuntime(next.messages, eventTime);
      next.isStreaming = false;
      next.isIdle = true;
      next.isCompacting = false;
      next.isRetrying = false;
      break;

    case "error": {
      const errText =
        typeof ev.error === "string"
          ? ev.error
          : typeof (ev as { message?: unknown }).message === "string"
            ? String((ev as { message: string }).message)
            : "Agent error";
      next.messages = settleOpenRuntime(next.messages, eventTime);
      next.messages.push({ role: "error", content: errText });
      next.isStreaming = false;
      next.isIdle = true;
      break;
    }

    default:
      break;
  }
}

function assistantDeltaEvent(
  envelope: TimedAgentEventEnvelope | undefined,
): Extract<SerializableAssistantMessageEvent, { delta: string }> | null {
  if (!envelope || envelope.payload.event.type !== "message_update") return null;
  const event = envelope.payload.event.assistantMessageEvent;
  return event && "delta" in event ? event : null;
}

function sameTimedAgentEventIdentity(
  left: TimedAgentEventEnvelope,
  right: TimedAgentEventEnvelope,
): boolean {
  return (
    left.hostInstanceId === right.hostInstanceId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.sessionId === right.sessionId &&
    left.sessionRevision === right.sessionRevision &&
    left.packageRevision === right.packageRevision
  );
}

function findToolExecution(
  messages: SerializableAgentMessage[],
  toolCallId: string,
): ToolExecutionPart | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    const part = message.content.find((item) => item.type === "toolCall" && item.id === toolCallId);
    if (part) return part as ToolExecutionPart;
  }
  return null;
}

function upsertToolExecutionInPlace(
  messages: SerializableAgentMessage[],
  toolCallId: string,
  part: ToolExecutionPart,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    if (message.content.some((item) => item.type === "toolCall" && item.id === toolCallId)) {
      messages[index] = {
        ...message,
        content: message.content.map((item) =>
          item.type === "toolCall" && item.id === toolCallId ? part : item,
        ),
      };
      return;
    }
  }
  messages.push({ role: "tool", content: [part] });
}

function normalizeMessage(message: unknown): SerializableAgentMessage | null {
  if (!message || typeof message !== "object") return null;
  const m = message as SerializableAgentMessage;
  if (typeof m.role !== "string") return null;
  return {
    ...m,
    role: m.role,
    content: (m.content as SerializableAgentMessage["content"]) ?? "",
  };
}

/** Plain text of a message content (string or [{type:"text"|...,text}] parts). */
function contentText(content: SerializableAgentMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

function contentImages(content: SerializableAgentMessage["content"]): Array<{
  data: string;
  mimeType: string;
}> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || part.type !== "image") return [];
    const value = part as { data?: unknown; mimeType?: unknown; mediaType?: unknown };
    if (typeof value.data !== "string") return [];
    const mimeType =
      typeof value.mimeType === "string"
        ? value.mimeType
        : typeof value.mediaType === "string"
          ? value.mediaType
          : "";
    return [{ data: value.data, mimeType }];
  });
}

function messagesMatchByContent(
  left: SerializableAgentMessage,
  right: SerializableAgentMessage,
): boolean {
  // Attachment reference/guide blocks are injected by the Host between the
  // optimistic echo and the authoritative message — strip them so the
  // optimistic row still matches the SDK's message in place.
  const leftText = stripAttachmentReferenceBlocks(contentText(left.content)).trim();
  const rightText = stripAttachmentReferenceBlocks(contentText(right.content)).trim();
  if (leftText || rightText) return leftText === rightText;
  const leftImages = contentImages(left.content);
  const rightImages = contentImages(right.content);
  return (
    leftImages.length > 0 &&
    leftImages.length === rightImages.length &&
    leftImages.every(
      (image, index) =>
        image.data === rightImages[index]?.data && image.mimeType === rightImages[index]?.mimeType,
    )
  );
}

/**
 * Replace the latest still-pending optimistic user bubble whose content
 * matches the incoming authoritative message. Returns true when upgraded.
 */
function replaceOptimisticUserMessageInPlace(
  messages: SerializableAgentMessage[],
  incoming: SerializableAgentMessage,
): boolean {
  let index = -1;
  for (let candidateIndex = messages.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = messages[candidateIndex]!;
    if (
      candidate.role === "user" &&
      typeof candidate._optimisticKey === "string" &&
      messagesMatchByContent(candidate, incoming)
    ) {
      index = candidateIndex;
      break;
    }
  }
  if (index === -1) return false;
  const { _optimisticKey: _dropped, ...authoritative } = incoming;
  messages[index] = authoritative;
  return true;
}

/**
 * Replace an already-upgraded optimistic row (same user content) when
 * message_end arrives after message_start, so a single user prompt never
 * renders twice.
 */
function replaceMatchingUserMessageInPlace(
  messages: SerializableAgentMessage[],
  incoming: SerializableAgentMessage,
): boolean {
  if (!contentText(incoming.content) && contentImages(incoming.content).length === 0) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    if (candidate.role === "user" && messagesMatchByContent(candidate, incoming)) {
      messages[index] = incoming;
      return true;
    }
  }
  return false;
}

function normalizeSessionEntry(value: unknown): SerializableSessionEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.type !== "string") return null;
  return entry as SerializableSessionEntry;
}

function extractGenericDelta(ev: AgentEventEnvelope["event"]): string {
  if (typeof ev.delta === "string") return ev.delta;
  if (ev.delta && typeof ev.delta === "object" && "text" in (ev.delta as object)) {
    return String((ev.delta as { text?: string }).text ?? "");
  }
  return "";
}

function numericField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function projectToolResult(value: unknown): {
  result?: string;
  resultBlocks?: JsonValue[];
  details?: JsonValue;
} {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") return value ? { result: value } : {};

  let content: unknown[] | null = null;
  if (Array.isArray(value)) {
    content = value;
  } else if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>).content;
    if (Array.isArray(candidate)) content = candidate;
  }
  if (content) {
    const blocks = content
      .filter((part): part is Record<string, unknown> =>
        Boolean(
          part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string",
        ),
      )
      .map((part) => toJsonValue(part));
    const text = blocks
      .map((part) =>
        part && typeof part === "object" && !Array.isArray(part) && typeof part.text === "string"
          ? part.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    return {
      ...(text ? { result: text } : {}),
      ...(blocks.length > 0 ? { resultBlocks: blocks } : {}),
      ...(record?.details !== undefined && record.details !== null
        ? { details: toJsonValue(record.details) }
        : {}),
    };
  }

  const serialized = toJsonish(value);
  return serialized ? { result: serialized } : {};
}

function mergeContentTiming(
  previous: SerializableAgentMessage["content"],
  current: SerializableAgentMessage["content"],
): SerializableAgentMessage["content"] {
  if (!Array.isArray(current) || !Array.isArray(previous)) return current;
  return current.map((part, index) => {
    const prior = previous[index];
    if (!prior || prior.type !== part.type) return part;
    const startedAt = numericField(part, "startedAt") ?? numericField(prior, "startedAt");
    const endedAt = numericField(part, "endedAt") ?? numericField(prior, "endedAt");
    return {
      ...part,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    };
  });
}

function streamRunMatches(row: SerializableAgentMessage, runId: string | undefined): boolean {
  // Events without a runId (older hosts / hand-built frames) keep the legacy
  // tail-merge behavior. With a runId the tail row must have been opened by
  // the same run — appending across a turn boundary corrupts the previous
  // assistant message with the new run's content. A snapshot-restored row
  // carries no marker; it stays adoptable while unsealed (no endedAt) so
  // mid-turn rehydrate resumes into it instead of duplicating it.
  if (runId === undefined) return true;
  const marker = (row as { _streamRunId?: unknown })._streamRunId;
  if (typeof marker === "string") return marker === runId;
  return numericField(row, "endedAt") === undefined;
}

function mergeLastAssistantInPlace(
  messages: SerializableAgentMessage[],
  message: SerializableAgentMessage,
  eventTime: number,
  complete: boolean,
  runId?: string,
): void {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || !streamRunMatches(last, runId)) {
    messages.push({
      ...message,
      startedAt: numericField(message, "startedAt") ?? eventTime,
      ...(complete ? { endedAt: eventTime } : {}),
    });
    return;
  }
  messages[messages.length - 1] = {
    ...message,
    content: mergeContentTiming(last.content, message.content),
    startedAt: numericField(message, "startedAt") ?? numericField(last, "startedAt") ?? eventTime,
    // The authoritative message carries no desktop-local fields; keep the
    // live-measured first-delta timestamp so the stats pills still see it.
    ...(numericField(last, "firstTokenAt") !== undefined
      ? { firstTokenAt: numericField(last, "firstTokenAt") }
      : {}),
    ...(complete ? { endedAt: eventTime } : {}),
  };
}

function appendAssistantContentEventInPlace(
  messages: SerializableAgentMessage[],
  event: SerializableAssistantMessageEvent,
  eventTime: number,
  runId?: string,
): void {
  const eventType = event.type;
  if (eventType === "start" || eventType === "done" || eventType === "error") return;
  const contentKind = eventType.startsWith("thinking_")
    ? "thinking"
    : eventType.startsWith("text_")
      ? "text"
      : "toolCall";

  const delta = "delta" in event ? event.delta : "content" in event ? event.content : "";
  const contentIndex = event.contentIndex;

  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !streamRunMatches(last, runId)) {
    messages.push({
      role: "assistant",
      content: [],
      startedAt: eventTime,
      ...(runId ? { _streamRunId: runId } : {}),
    });
  }

  const assistant = stampFirstDeltaInPlace(messages, eventTime);
  if (contentKind === "text" && typeof assistant.content === "string" && contentIndex === 0) {
    if (delta && eventType === "text_delta") {
      messages[messages.length - 1] = { ...assistant, content: assistant.content + delta };
    } else if (eventType === "text_end") {
      messages[messages.length - 1] = { ...assistant, content: delta };
    }
    return;
  }

  const parts = Array.isArray(assistant.content)
    ? Array.from(
        { length: Math.max(assistant.content.length, contentIndex + 1) },
        (_, index): SerializableAgentContent => {
          const part = assistant.content[index] as SerializableAgentContent | undefined;
          return part && typeof part === "object" && typeof part.type === "string"
            ? part
            : { type: "text", text: "" };
        },
      )
    : assistant.content
      ? [{ type: "text", text: assistant.content }]
      : Array.from({ length: contentIndex + 1 }, (): SerializableAgentContent => ({
          type: "text",
          text: "",
        }));
  const current = parts[contentIndex];
  if (contentKind === "toolCall") {
    if (event.type === "toolcall_start") {
      parts[contentIndex] = {
        type: "toolCall",
        id: event.id,
        name: event.name,
        arguments: {},
        argumentsText: "",
        startedAt: eventTime,
      };
    } else if (event.type === "toolcall_delta") {
      const argumentsText = `${
        current && typeof current.argumentsText === "string" ? current.argumentsText : ""
      }${event.delta}`;
      parts[contentIndex] = {
        ...(current?.type === "toolCall" ? current : { type: "toolCall" }),
        arguments: parseToolArguments(argumentsText),
        argumentsText,
        startedAt: numericField(current, "startedAt") ?? eventTime,
      };
    } else if (event.type === "toolcall_end") {
      const toolCall = normalizeAgentContent(event.toolCall);
      if (toolCall) {
        parts[contentIndex] = {
          ...toolCall,
          startedAt: numericField(current, "startedAt") ?? eventTime,
        };
      }
    } else {
      return;
    }
    messages[messages.length - 1] = { ...assistant, content: parts };
    return;
  }

  const currentValue =
    contentKind === "thinking"
      ? typeof current?.thinking === "string"
        ? current.thinking
        : ""
      : typeof current?.text === "string"
        ? current.text
        : "";

  if (!current || current.type !== contentKind) {
    parts[contentIndex] =
      contentKind === "thinking"
        ? { type: "thinking", thinking: delta, startedAt: eventTime }
        : { type: "text", text: delta };
  } else if (delta && eventType.endsWith("_delta")) {
    parts[contentIndex] =
      contentKind === "thinking"
        ? { ...current, thinking: currentValue + delta }
        : { ...current, text: currentValue + delta };
  } else if (eventType.endsWith("_end")) {
    parts[contentIndex] =
      contentKind === "thinking" ? { ...current, thinking: delta } : { ...current, text: delta };
  }

  const updated = parts[contentIndex];
  if (contentKind === "thinking" && updated) {
    parts[contentIndex] = {
      ...updated,
      startedAt: numericField(updated, "startedAt") ?? eventTime,
      ...(eventType === "thinking_end" ? { endedAt: eventTime } : {}),
    };
  }

  messages[messages.length - 1] = { ...assistant, content: parts };
}

/**
 * First content delta on one assistant row stamps the live-measured
 * first-delta timestamp; the stats pills read it with `startedAt` (TTFT) and
 * `endedAt` (decode speed). Session-restored rows never carry it, so only
 * genuinely streamed turns contribute.
 */
function stampFirstDeltaInPlace(
  messages: SerializableAgentMessage[],
  eventTime: number,
): SerializableAgentMessage {
  const assistant = messages[messages.length - 1]!;
  if (numericField(assistant, "firstTokenAt") !== undefined) return assistant;
  const next = { ...assistant, firstTokenAt: eventTime };
  messages[messages.length - 1] = next;
  return next;
}

function appendTextDeltaInPlace(
  messages: SerializableAgentMessage[],
  delta: string,
  eventTime: number,
  runId?: string,
): void {
  if (!delta) return;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !streamRunMatches(last, runId)) {
    messages.push({
      role: "assistant",
      content: delta,
      startedAt: eventTime,
      firstTokenAt: eventTime,
      ...(runId ? { _streamRunId: runId } : {}),
    });
    return;
  }
  const assistant = stampFirstDeltaInPlace(messages, eventTime);
  const content = assistant.content;
  if (typeof content === "string") {
    messages[messages.length - 1] = { ...assistant, content: content + delta };
  } else if (Array.isArray(content)) {
    const parts = [...content];
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
      parts[parts.length - 1] = { ...lastPart, text: lastPart.text + delta };
    } else {
      parts.push({ type: "text", text: delta });
    }
    messages[messages.length - 1] = { ...assistant, content: parts };
  } else {
    messages[messages.length - 1] = { ...assistant, content: delta };
  }
}

function settleOpenRuntime(
  messages: SerializableAgentMessage[],
  eventTime: number,
): SerializableAgentMessage[] {
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant") lastAssistant = index;
  });

  return messages.map((message, messageIndex) => {
    let nextMessage = message;
    if (messageIndex === lastAssistant && numericField(message, "endedAt") === undefined) {
      nextMessage = { ...nextMessage, endedAt: eventTime };
    }
    if (!Array.isArray(message.content)) return nextMessage;
    if (message.role === "assistant") {
      const content = message.content.map((part) => {
        if (!["toolCall", "tool_use", "functionCall"].includes(part.type)) return part;
        const status = typeof part.status === "string" ? part.status : "waiting";
        if (status !== "running" && status !== "waiting") return part;
        return { ...part, status: "aborted", endedAt: eventTime };
      });
      return { ...nextMessage, content };
    }
    if (message.role !== "tool") return nextMessage;
    const content = message.content.map((part) => {
      const status = typeof part.status === "string" ? part.status : "";
      if (status !== "running" && status !== "waiting") return part;
      return { ...part, status: "aborted", text: "aborted", endedAt: eventTime };
    });
    return { ...nextMessage, content };
  });
}

function normalizeAgentContent(value: JsonValue): SerializableAgentContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.type === "string" ? (value as SerializableAgentContent) : null;
}

function parseToolArguments(value: string): JsonValue {
  if (!value.trim()) return {};
  try {
    return toJsonValue(JSON.parse(value));
  } catch {
    try {
      return toJsonValue(parsePartialJson(value));
    } catch {
      return {};
    }
  }
}

function toJsonish(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
