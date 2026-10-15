/**
 * 委派面板的「跳转」：打开一个会话。
 *
 * 面板只给会话级坐标（cwd + sessionId），不再定位到某条消息——要说什么，跳进会话
 * 对着说就是了。
 *
 * **会话检测在跳转之前，而且不靠回查 Host**：面板上的行来自 Host 的派发记录，会话
 * 被删掉之后这些行还留着；Host 的 taskTree 投影已经按磁盘看过一眼，把落点路径与
 * 存活状态（active / archived / missing）随行一起给下来了。所以：
 * - `missing`（文件两处都没有，多半被删）：**就地判掉**——不切工作区、不试
 *   session.open、页面也不动，只给一句明确的提示。此前这里做不到：跨工作区时
 *   session.list 要等目标工作区成为活动工作区才查得到，只能先把工作区切走再发现
 *   打不开，用户平白落进一个说不清的加载页。
 * - `archived`：同理就地提示去恢复，跳过去也打不开。
 * - `active`：拿着记录里的 sessionPath 直接开（跳过解析），少一次往返。
 * - `unknown`（记录里没有落点路径）：退回按 sessionId 解析，解析不到仍按「已删除」
 *   报——这是唯一还得问一次 Host 的分支。
 */
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import type { PixieSessionLiveness } from "@piabyss/protocol";
import { tCurrent } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

const SESSION_LIST_TIMEOUT_MS = 30_000;

/** 面板一行给出的跳转目标。 */
export type PixieSessionTarget = {
  cwd: string;
  sessionId: string;
  /** Host 投影带下来的落点路径；未落点（受理前就失败）的记录为 null。 */
  sessionPath: string | null;
  /** Host 投影带下来的存活状态；missing / archived 就地判掉。 */
  liveness: PixieSessionLiveness;
};

/** 跳转只用到 session.list 里的这两项。 */
type ResolvedSession = { sessionPath: string; archived?: boolean };

/**
 * 会话检测的三态。`missing` 是**明确查无此条**（= 已被删除）；`unknown` 是这次问不出来
 * （没 Host / 没工作区 / 请求失败）——它绝不能当成已删除，否则网络抖一下就不给跳了。
 */
type SessionLookup =
  { status: "found"; session: ResolvedSession } | { status: "missing" } | { status: "unknown" };

/**
 * 问当前活动工作区要一次会话列表，查目标会话在不在。只在 `unknown`（记录里没有
 * 落点路径）时才会走到这里——那时解析器是在目标工作区已经切过去之后被调用的。
 */
async function lookupSessionInActiveWorkspace(sessionId: string): Promise<SessionLookup> {
  const current = useAppStore.getState();
  if (!current.host || !current.workspace) return { status: "unknown" };
  const response = await hostClient.request(
    "session.list",
    workspaceContext(current.host, current.workspace),
    null,
    SESSION_LIST_TIMEOUT_MS,
  );
  if (!response.ok) return { status: "unknown" };
  const item = response.result.items.find((entry) => entry.sessionId === sessionId);
  if (!item) return { status: "missing" };
  return { status: "found", session: { sessionPath: item.sessionPath, archived: item.archived } };
}

function reportSessionGone(): void {
  useAppStore.getState().pushNotification(tCurrent("pixieSessionGone"), "warning");
}

function reportSessionArchived(): void {
  // 与「已删除」同为 warning：这条也得进通知中心——用户点一次、没跳成，就该留下记录，
  // 而不是一条飘过就没了、下次点还是同样的困惑。
  useAppStore.getState().pushNotification(tCurrent("pixieSessionArchived"), "warning");
}

/**
 * 执行跳转。返回 false 表示没打开：会话已删除 / 已归档 / 工作区不可达 / 被忙面阻塞。
 * 「会话已删除」与「会话已归档」在这里给明确提示（且**发生在任何工作区切换之前**），
 * 其余失败沿用会话导航自己的上报口径，只有查不到（resolver 失败、session.open 报错）
 * 时才补一条通用的失败提示。
 */
export async function jumpToPixieSession(target: PixieSessionTarget): Promise<boolean> {
  if (!useAppStore.getState().host) return false;

  // ① 落点已经没了：就地判掉，一步都不往前走。这一步在切换工作区之前，
  //    页面因此不会离开小精灵页。
  if (target.liveness === "missing") {
    reportSessionGone();
    return false;
  }
  if (target.liveness === "archived") {
    reportSessionArchived();
    return false;
  }

  // ② 有落点路径就直接开（Host 侧会话导航会处理跨工作区的激活）；没有才退回解析。
  //    quiet 是为了不让会话导航再补一条泛泛的「打开会话失败」，文案按下面分清后自己给。
  let sessionMissing = false;
  const outcome = await openSessionAcrossWorkspaces(
    {
      cwd: target.cwd,
      sessionId: target.sessionId,
      ...(target.sessionPath ? { sessionPath: target.sessionPath } : {}),
      quiet: true,
    },
    {
      resolveSessionPath: async (sessionId) => {
        const lookup = await lookupSessionInActiveWorkspace(sessionId);
        if (lookup.status === "missing") {
          sessionMissing = true;
          return null;
        }
        return lookup.status === "found" ? lookup.session : null;
      },
    },
  );
  if (sessionMissing) {
    reportSessionGone();
    return false;
  }
  if (outcome.status === "archived") {
    reportSessionArchived();
    return false;
  }
  if (outcome.status !== "opened" && outcome.status !== "already-active") {
    // 会话导航被 quiet 了，剩下的真失败（Host 报错 / 忙面）在这里补上。
    if (outcome.status === "failed") {
      useAppStore.getState().pushNotification(tCurrent("notifOpenSessionFailed"), "error");
    }
    return false;
  }
  // 目标就是眼前这条会话时别把用户从当前页赶走（小精灵页里点自己那一段）。
  const active = useAppStore.getState().session;
  if (outcome.status !== "already-active" || active?.sessionId !== target.sessionId) {
    useAppStore.getState().setPage("chat");
  }
  return true;
}
