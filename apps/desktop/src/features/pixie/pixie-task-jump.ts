/**
 * 任务行「跳转定位」：把工作区 → 会话 → 任务树里的一条任务打开到它锚点所在的消息。
 *
 * 锚点可能不在任务所属工作区（结果回执注入的是小精灵段会话），所以目标坐标
 * 全部由 Host 算好的 `jump` 决定，这里只负责「打开 + 落地后滚动」。
 * 老记录没有锚点（`messageId=null`）时照常打开会话，不做滚动。
 */
import type { PixieTaskJump } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { scrollTranscriptToSource } from "../../lib/transcript-navigation";
import { useAppStore } from "../../lib/stores/app-store";

const SESSION_LIST_TIMEOUT_MS = 30_000;

/** 只有会话坐标、没有路径时经 session.list 反查（同备忘录「继续讨论」口径）。 */
async function resolveSessionPath(
  sessionId: string,
): Promise<{ sessionPath: string; archived?: boolean } | null> {
  const current = useAppStore.getState();
  if (!current.host || !current.workspace) return null;
  const response = await hostClient.request(
    "session.list",
    workspaceContext(current.host, current.workspace),
    null,
    SESSION_LIST_TIMEOUT_MS,
  );
  if (!response.ok) return null;
  const item = response.result.items.find((entry) => entry.sessionId === sessionId);
  if (!item) return null;
  return { sessionPath: item.sessionPath, archived: item.archived };
}

/** 该任务是否能跳到一个会话（既无会话 id 又无路径 = 从未落点，按钮该禁用）。 */
export function canJumpToPixieTask(jump: PixieTaskJump): boolean {
  return Boolean(jump.sessionId || jump.sessionPath);
}

/**
 * 执行跳转。返回 false 表示没打开成功（会话已删除 / 工作区不可达 / 被忙面阻塞）：
 * 失败提示由 openSessionAcrossWorkspaces 自己上报，这里不重复弹。
 */
export async function jumpToPixieTask(jump: PixieTaskJump): Promise<boolean> {
  if (!useAppStore.getState().host) return false;
  if (!canJumpToPixieTask(jump)) return false;
  const outcome = await openSessionAcrossWorkspaces(
    {
      cwd: jump.cwd,
      ...(jump.sessionId ? { sessionId: jump.sessionId } : {}),
      ...(jump.sessionPath ? { sessionPath: jump.sessionPath } : {}),
    },
    { resolveSessionPath },
  );
  if (outcome.status !== "opened" && outcome.status !== "already-active") return false;
  // 目标就是要滚到那一条；已经落在屏幕上时不必跳页（结果回执多半就在小精灵页
  // 当前的段会话里，跳去 chat 页反而像被赶走了）。其余情况离开小精灵页：本页
  // 的转写不是目标会话，卸载后 chat 页才会挂载目标转写。
  const active = useAppStore.getState().session;
  const alreadyOnScreen =
    outcome.status === "already-active" &&
    Boolean(jump.sessionId) &&
    active?.sessionId === jump.sessionId;
  if (!alreadyOnScreen) useAppStore.getState().setPage("chat");
  if (jump.messageId) scrollTranscriptToSource(jump.messageId);
  return true;
}
