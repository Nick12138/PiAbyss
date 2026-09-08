import {
  toJsonValue,
  type SerializableAgentSessionEvent,
  type SerializableAssistantMessageEvent,
} from "@piabyss/protocol";

type EventRecord = Record<string, unknown>;

const EVENT_FIELDS = {
  agent_start: [],
  agent_end: ["messages", "willRetry"],
  turn_start: [],
  turn_end: ["message", "toolResults"],
  message_start: ["message"],
  message_update: [],
  message_end: ["message"],
  tool_execution_start: ["toolCallId", "toolName", "args"],
  tool_execution_update: ["toolCallId", "toolName", "args", "partialResult"],
  tool_execution_end: ["toolCallId", "toolName", "result", "isError"],
  agent_settled: [],
  queue_update: ["steering", "followUp"],
  compaction_start: ["reason"],
  entry_appended: ["entry"],
  session_info_changed: ["name"],
  thinking_level_changed: ["level"],
  compaction_end: ["reason", "result", "aborted", "willRetry", "errorMessage"],
  auto_retry_start: ["attempt", "maxAttempts", "delayMs", "errorMessage"],
  auto_retry_end: ["success", "attempt", "finalError"],
  // Retries of the summarization LLM call inside compaction or branch-summary.
  // The desktop uses these to keep the header truthful while a summarization
  // attempt is backing off; `bash_execution_update` stays unreviewed because
  // nothing in PiAbyss calls AgentSession.executeBash, its only emitter.
  summarization_retry_scheduled: ["attempt", "maxAttempts", "delayMs", "errorMessage"],
  summarization_retry_attempt_start: ["source", "reason"],
  summarization_retry_finished: [],
  error: ["error", "message"],
} as const satisfies Record<string, readonly string[]>;

type SupportedEventType = keyof typeof EVENT_FIELDS;

/** Normalize reviewed AgentSession fields for the JSONL Host/Desktop boundary. */
export function normalizeAgentEvent(event: unknown): SerializableAgentSessionEvent {
  if (!isRecord(event) || typeof event.type !== "string" || !isSupportedEvent(event.type)) {
    return { type: "unknown" };
  }

  const type = event.type;
  if (type === "message_update") {
    const assistantMessageEvent = normalizeAssistantMessageEvent(event.assistantMessageEvent);
    return assistantMessageEvent ? { type, assistantMessageEvent } : { type: "unknown" };
  }
  const out: EventRecord = { type };
  for (const field of EVENT_FIELDS[type]) {
    if (!Object.hasOwn(event, field) || event[field] === undefined) continue;
    if (type === "tool_execution_end" && field === "result") {
      out.result = normalizeToolResult(event.result);
    } else if (type === "tool_execution_update" && field === "partialResult") {
      out.partialResult = normalizeToolResult(event.partialResult);
    } else {
      out[field] = toJsonValue(event[field]);
    }
  }

  return out as SerializableAgentSessionEvent;
}

function normalizeAssistantMessageEvent(value: unknown): SerializableAssistantMessageEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const type = value.type;
  if (type === "start") return { type };
  if (type === "done") {
    return typeof value.reason === "string" ? { type, reason: value.reason } : null;
  }
  if (type === "error") {
    if (typeof value.reason !== "string") return null;
    const errorMessage =
      isRecord(value.error) && typeof value.error.errorMessage === "string"
        ? value.error.errorMessage
        : undefined;
    return { type, reason: value.reason, ...(errorMessage ? { errorMessage } : {}) };
  }

  const contentIndex = value.contentIndex;
  if (!Number.isSafeInteger(contentIndex) || Number(contentIndex) < 0) return null;
  const index = Number(contentIndex);
  switch (type) {
    case "text_start":
    case "thinking_start":
      return { type, contentIndex: index };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return typeof value.delta === "string"
        ? { type, contentIndex: index, delta: value.delta }
        : null;
    case "text_end":
    case "thinking_end":
      return typeof value.content === "string"
        ? { type, contentIndex: index, content: value.content }
        : null;
    case "toolcall_start": {
      const toolCall = partialContentAt(value.partial, index);
      if (!toolCall || typeof toolCall.id !== "string" || typeof toolCall.name !== "string") {
        return null;
      }
      return { type, contentIndex: index, id: toolCall.id, name: toolCall.name };
    }
    case "toolcall_end": {
      if (!isRecord(value.toolCall) || typeof value.toolCall.type !== "string") return null;
      return {
        type,
        contentIndex: index,
        toolCall: toJsonValue(value.toolCall),
      };
    }
    default:
      return null;
  }
}

function partialContentAt(partial: unknown, index: number): EventRecord | null {
  if (!isRecord(partial) || !Array.isArray(partial.content)) return null;
  const content = partial.content[index];
  return isRecord(content) ? content : null;
}

function isSupportedEvent(type: string): type is SupportedEventType {
  return Object.hasOwn(EVENT_FIELDS, type);
}

function isRecord(value: unknown): value is EventRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolResult(result: unknown): unknown {
  if (!isRecord(result)) return toJsonValue(result);
  const out: EventRecord = {
    content: toJsonValue(result.content ?? []),
    details: toJsonValue(result.details ?? null),
  };
  if (Array.isArray(result.addedToolNames)) {
    out.addedToolNames = result.addedToolNames.filter((name) => typeof name === "string");
  }
  if (typeof result.terminate === "boolean") {
    out.terminate = result.terminate;
  }
  return out;
}
