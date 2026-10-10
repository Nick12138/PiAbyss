/**
 * 跨组件的「在备忘录页里打开这条记录的详情（预览）」请求。
 *
 * 触发方是桌面速记小窗：点击待办 → Rust `memo_widget_show_main` 显示主窗口
 * 并把 noteId 随 `memo-widget-open-memo` 事件广播；App.tsx 收到后切到备忘录
 * 页并调用 requestMemoReveal。此时 MemoPage 可能还没挂载（当前不在备忘页），
 * 请求先挂在本模块；MemoPage 订阅时补投一次（session-reveal 同款模式）。
 *
 * （小窗的机器人按钮不走这里：那是「交给 Agent」动作，App.tsx 直接调用
 * memo-agent 的 openMemoWithAgentById，不经备忘录页直达会话页。）
 */

export type MemoRevealRequest = {
  noteId: string;
};

type MemoRevealHandler = (request: MemoRevealRequest) => void;

const handlers = new Set<MemoRevealHandler>();

/**
 * 只补投 10 秒内的请求——再晚的挂载（用户切页等）就该是新的一屏了，
 * 不该突然跳到某条记录的详情。
 */
const PENDING_TTL_MS = 10_000;
let pending: { request: MemoRevealRequest; at: number } | null = null;

export function requestMemoReveal(noteId: string): void {
  pending = { request: { noteId }, at: Date.now() };
  for (const handler of handlers) handler(pending.request);
}

export function subscribeMemoReveal(handler: MemoRevealHandler): () => void {
  handlers.add(handler);
  if (pending && Date.now() - pending.at <= PENDING_TTL_MS) handler(pending.request);
  return () => handlers.delete(handler);
}

/** pending 是模块级状态，测试用例之间必须复位。 */
export function clearPendingMemoRevealForTest(): void {
  pending = null;
}
