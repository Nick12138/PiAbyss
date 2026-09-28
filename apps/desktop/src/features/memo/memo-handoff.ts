/**
 * 备忘录「用 Agent 处理」的交接落地：注入引用胶囊只是**预约**，
 * 真正把记录置为「进行中」并绑定会话，必须等到用户把消息发出去。
 *
 * 反例（旧实现）：点「用 Agent 处理」就立刻置为 in_progress 并绑定新会话。
 * 用户没发消息就离开 / 把会话删掉时，记录会一直卡在「进行中」且指向一个
 * 打不开的会话（详情页「打开关联会话」报错）。改成发送时绑定后，只有真的
 * 有消息发出，才会产生绑定。
 */
import type { DraftReference } from "../../lib/draft-target";
import { updateMemoNote } from "./memo-client";

/** 引用 id 前缀，见 MemoPage 注入时的 `memo:<noteId>`。 */
const MEMO_REFERENCE_PREFIX = "memo:";

/**
 * 从草稿引用里取出备忘录记录 id（按出现顺序去重）。
 * 只认结构化引用——正文里粘贴的 memo 块不算「用 Agent 处理」的交接。
 */
export function memoHandoffNoteIds(references: readonly DraftReference[]): string[] {
  const ids: string[] = [];
  for (const reference of references) {
    if (reference.kind !== "memo") continue;
    if (!reference.id.startsWith(MEMO_REFERENCE_PREFIX)) continue;
    const id = reference.id.slice(MEMO_REFERENCE_PREFIX.length).trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 消息已发出：把引用到的记录置为「进行中」并绑定当前会话（同时清掉可能残留的
 * 旧总结，避免和本轮结果混淆）。
 *
 * 失败只告警不抛出：绑定是发送流程的附带动作，失败不该影响已经发出去的消息；
 * Agent 完成后仍会通过 complete 动作写回 done + sessionId。
 */
export async function bindMemoHandoffsToSession(
  references: readonly DraftReference[],
  sessionId: string | null,
): Promise<void> {
  if (!sessionId) return;
  const ids = memoHandoffNoteIds(references);
  if (ids.length === 0) return;
  await Promise.all(
    ids.map(async (id) => {
      try {
        await updateMemoNote(id, { status: "in_progress", sessionId, clearResult: true });
      } catch (error) {
        console.warn("[piabyss] memo handoff bind failed", id, error);
      }
    }),
  );
}
