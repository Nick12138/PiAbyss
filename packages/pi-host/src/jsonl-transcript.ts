/**
 * 读盘上的会话 jsonl，投影成前端共享转写（`buildTranscriptRows`）能直接消费的形状。
 *
 * 目前唯一的调用方是 `schedule.runMessages`：一次计划执行的**过程**。之所以不走
 * 插件的 `/runs/:id/transcript`，是因为那个端点把消息拍平成纯文本、连 `toolResult`
 * 都不返回，撑不出「像普通会话那样折叠思考与工具调用」。会话文件本来就在宿主可读的
 * 数据根里，直接投影更省事也更完整。
 *
 * 这块逻辑原先长在 `schedule-agent-runner.ts`（智能创建会话）里，随那条路径下线
 * 一起搬了出来——读盘投影与「谁来创建会话」本来就没有关系。
 */
import { existsSync, readFileSync } from "node:fs";

/** One projected transcript message.
 *
 * `content` keeps the real content blocks (text / thinking / toolCall / image)
 * and `toolCallId`/`toolName` the result linkage, so the desktop can run the
 * message through the same `buildTranscriptRows` projection as a normal
 * workspace session — reasoning and tool calls then fold through the shared
 * ThinkingBlock / ExecutionTrace disclosures. `text`/`reasoning` remain the
 * flattened projections used for plan-block extraction and backlog titles. */
export type TranscriptMessage = {
  role: string;
  text: string;
  reasoning?: string;
  content?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

/** Project one session message into the wire shape. */
function projectMessage(message: {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
}): TranscriptMessage {
  const role = String(message.role ?? "unknown");
  const { text, reasoning, content } = extractContent(message.content);
  const projected: TranscriptMessage = { role, text: truncate(text) };
  if (reasoning) projected.reasoning = truncate(reasoning);
  if (content.length > 0) projected.content = boundBlocks(content);
  if (typeof message.toolCallId === "string") projected.toolCallId = message.toolCallId;
  if (typeof message.toolName === "string") projected.toolName = message.toolName;
  if (message.isError === true) projected.isError = true;
  return projected;
}

/** One message's content blocks, split by kind.
 *
 * Reasoning is kept apart from the answer text and tool calls keep their own
 * blocks: flattening them into `[thinking] …` / `[tool] name` lines (the old
 * behavior) left the desktop nothing to fold, so the panel rendered raw
 * thoughts and bare tool names inline instead of the conversation area's
 * disclosures. */
function extractContent(content: unknown): {
  text: string;
  reasoning: string;
  content: unknown[];
} {
  if (typeof content === "string") {
    const text = content.trim();
    // Legacy sessions stored plain strings; synthesize the block so the
    // projection still has something to render.
    return { text, reasoning: "", content: text ? [{ type: "text", text }] : [] };
  }
  if (!Array.isArray(content)) return { text: "", reasoning: "", content: [] };
  const parts: string[] = [];
  const thoughts: string[] = [];
  const blocks: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
    blocks.push(block);
  }
  return {
    text: parts.join("\n").trim(),
    reasoning: thoughts.join("\n\n").trim(),
    content: blocks,
  };
}

function truncate(value: string): string {
  return value.length > 20_000 ? `${value.slice(0, 20_000)}…(已截断)` : value;
}

/** Bound each block's text so tool output cannot blow up the polled payload. */
function boundBlocks(blocks: unknown[]): unknown[] {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    const record = block as { text?: unknown; thinking?: unknown };
    if (typeof record.text === "string") {
      return { ...record, text: truncate(record.text) };
    }
    if (typeof record.thinking === "string") {
      return { ...record, thinking: truncate(record.thinking) };
    }
    return block;
  });
}

/** Minimal JSONL transcript read for sessions that are not resident in memory. */
export function agentTranscriptFrom(sessionPath: string): TranscriptMessage[] {
  if (!existsSync(sessionPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return [];
  }
  const out: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = (parsed.message ?? {}) as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    const projected = projectMessage(message);
    if (!projected.text && !projected.reasoning && !projected.content?.length) continue;
    out.push(projected);
  }
  return out;
}
