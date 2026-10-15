/**
 * 委派面板的「跳转」：打开一个会话。
 *
 * 面板只给会话级坐标（cwd + sessionId），不再定位到某条消息——要说什么，跳进会话
 * 对着说就是了。只有 id、没有路径时经 session.list 反查（同备忘录「继续讨论」口径）。
 */
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { useAppStore } from "../../lib/stores/app-store";

const SESSION_LIST_TIMEOUT_MS = 30_000;

/** 面板一行给出的跳转目标。 */
export type PixieSessionTarget = { cwd: string; sessionId: string };

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

/**
 * 执行跳转。返回 false 表示没打开成功（会话已删除 / 工作区不可达 / 被忙面阻塞）：
 * 失败提示由 openSessionAcrossWorkspaces 自己上报，这里不重复弹。
 */
export async function jumpToPixieSession(target: PixieSessionTarget): Promise<boolean> {
  if (!useAppStore.getState().host) return false;
  const outcome = await openSessionAcrossWorkspaces(
    { cwd: target.cwd, sessionId: target.sessionId },
    { resolveSessionPath },
  );
  if (outcome.status !== "opened" && outcome.status !== "already-active") return false;
  // 目标就是眼前这条会话时别把用户从当前页赶走（小精灵页里点自己那一段）。
  const active = useAppStore.getState().session;
  if (outcome.status !== "already-active" || active?.sessionId !== target.sessionId) {
    useAppStore.getState().setPage("chat");
  }
  return true;
}
