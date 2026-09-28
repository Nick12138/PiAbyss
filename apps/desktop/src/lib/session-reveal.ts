/**
 * 跨组件的「把这个会话在侧边栏里定位出来」请求。
 *
 * 归档会话是冻结文件：Host 的 session.open 只在活动目录里查找（见
 * pi-host/session-lifecycle 的 openSession），打开必然失败。所以调用方
 * （备忘录「打开关联会话」、全局搜索）能做的就是切开侧边栏的「已归档」分组，
 * 把那一行滚进可视区并短暂高亮，剩下的「恢复 / 删除」由用户自己决定。
 */
export type SessionRevealRequest = {
  /** 目标会话所属工作区；列表只在自己这个工作区里匹配（null = 不限定）。 */
  workspaceId: string | null;
  sessionId: string;
  /** true = 目标落在「已归档」筛选里。 */
  archived: boolean;
};

type SessionRevealHandler = (request: SessionRevealRequest) => void;

const handlers = new Set<SessionRevealHandler>();

/**
 * 侧边栏折叠时 SessionList 根本不在树上，请求会先挂在这里；等它订阅时补投一次。
 * 只补投 10 秒内的请求——再晚的重新挂载（收起/展开侧边栏）就该是新的一屏了，
 * 不该突然跳到「已归档」分组。
 */
const PENDING_TTL_MS = 10_000;
let pending: { request: SessionRevealRequest; at: number } | null = null;

export function requestSessionReveal(request: SessionRevealRequest): void {
  pending = { request: { ...request }, at: Date.now() };
  for (const handler of handlers) handler(pending.request);
}

export function subscribeSessionReveal(handler: SessionRevealHandler): () => void {
  handlers.add(handler);
  if (pending && Date.now() - pending.at <= PENDING_TTL_MS) handler(pending.request);
  return () => handlers.delete(handler);
}

/** pending 是模块级状态，测试用例之间必须复位。 */
export function clearPendingSessionRevealForTest(): void {
  pending = null;
}
