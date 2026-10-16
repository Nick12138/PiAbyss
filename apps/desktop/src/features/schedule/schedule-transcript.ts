/**
 * 把 Host 投影出来的会话消息（`ScheduleAgentMessage`）换成共享转写投影吃的形状。
 *
 * 这份适配存在的意义只有一句话：**执行过程要用和普通会话一模一样的折叠渲染**。
 * `toolResult` 的关联字段必须原样带过去，`buildTranscriptRows` 才能把工具调用
 * 落定成 done/error，而不是留一个永远转圈的卡。
 */
import type {
  ScheduleAgentMessage,
  SerializableAgentContent,
  SerializableAgentMessage,
} from "@piabyss/protocol";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import { stripPlanFences } from "./schedule-plan-fence";

function toSerializable(message: ScheduleAgentMessage): SerializableAgentMessage | null {
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      content: Array.isArray(message.content)
        ? (message.content as SerializableAgentContent[])
        : "",
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.isError ? { isError: true } : {}),
    };
  }
  if (message.role !== "user" && message.role !== "assistant") return null;
  const raw = Array.isArray(message.content) ? (message.content as SerializableAgentContent[]) : [];
  const blocks: SerializableAgentContent[] = [];
  for (const block of raw) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      // 围栏喂给确认卡，正文才进气泡：两段都显示会把用户淹死。
      const text = stripPlanFences(typeof block.text === "string" ? block.text : "");
      if (text) blocks.push({ ...block, text });
      continue;
    }
    blocks.push(block);
  }
  if (blocks.length === 0) {
    // 老宿主或持久化过的会话只留了拍平字段——至少别渲染成空白。
    if (message.reasoning) blocks.push({ type: "thinking", thinking: message.reasoning });
    if (message.text) blocks.push({ type: "text", text: stripPlanFences(message.text) });
  }
  if (blocks.length === 0) return null;
  return { role: message.role as "user" | "assistant", content: blocks };
}

/** 一次执行的过程 → 共享转写的行（连续的 assistant 会并成一轮，折叠口径与普通会话同源）。 */
export function buildRunRows(
  messages: readonly ScheduleAgentMessage[],
  turnActive: boolean,
): TranscriptRow[] {
  const projected: SerializableAgentMessage[] = [];
  for (const message of messages) {
    const next = toSerializable(message);
    if (next) projected.push(next);
  }
  return buildTranscriptRows(projected, { turnActive });
}
