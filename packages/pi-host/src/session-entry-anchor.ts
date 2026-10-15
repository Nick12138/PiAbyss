/**
 * 消息锚点反查：把「会话里某条被注入的消息」映射成它的 session entry id。
 *
 * SDK 的 `message_end` 事件只带消息本体，落盘（`appendMessage`）发生在事件广播
 * **之后**，且普通消息不会另外触发 `entry_appended`——所以监听器当场按引用去
 * branch 里反查会落空，必须延后再试几次。拿到 entry id 只服务一件事：前端
 * 「跳转定位」要滚到的那条消息（TranscriptRow.sourceId 就是同一个 entry id）。
 *
 * 匹配一律用信封标记文本，且只认武装订阅**之后**新出现的消息：会话里可能已经
 * 躺着同一任务早先的信封，预扫描会把锚点定到错误的消息上。
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** 落盘重试节奏（ms）：覆盖 message_end → appendMessage 的间隙与 steer 推迟。 */
const ENTRY_LOOKUP_DELAYS_MS = [0, 25, 120, 500, 2_000];

/** 信封出现的最长等待：超时只意味着锚点缺失（不影响委派本身）。 */
const DEFAULT_ANCHOR_TIMEOUT_MS = 60_000;

function textOfMessage(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: string }).type === "text"
          ? String((block as { text?: string }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return "";
}

/** 按消息对象引用在会话分支里找 entry id（找不到 = 尚未落盘或已离枝）。 */
export function findEntryIdForMessage(session: AgentSession, message: unknown): string | null {
  let branch: readonly { type: string; id: string; message?: unknown }[];
  try {
    branch = session.sessionManager.getBranch();
  } catch {
    return null;
  }
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || entry.type !== "message") continue;
    if (entry.message === message) return entry.id;
  }
  return null;
}

/**
 * 已拿到消息本体、只等它落盘：按重试节奏解析 entry id，命中后回调一次。
 * 返回取消函数（不再需要时清掉排队中的重试）。
 */
export function resolveMessageEntryId(args: {
  session: AgentSession;
  message: unknown;
  onFound: (entryId: string) => void;
}): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let settled = false;
  const attempt = (delayIndex: number): void => {
    if (settled) return;
    const entryId = findEntryIdForMessage(args.session, args.message);
    if (entryId) {
      settled = true;
      args.onFound(entryId);
      return;
    }
    const delay = ENTRY_LOOKUP_DELAYS_MS[delayIndex];
    if (delay === undefined) return; // 落盘始终没等到：放弃，锚点留空
    timers.push(setTimeout(() => attempt(delayIndex + 1), delay));
  };
  attempt(0);
  return () => {
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  };
}

/**
 * 等会话里出现第一条包含 `marker` 的 user 消息，解析出它的 entry id 后回调。
 * 命中一次即结束；返回的函数用于提前取消（委派记录被丢弃时不必再等）。
 */
export function watchMessageEntryId(args: {
  session: AgentSession;
  marker: string;
  onFound: (entryId: string) => void;
  timeoutMs?: number;
}): () => void {
  let stopResolve: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const unsubscribe = args.session.subscribe((event: AgentSessionEvent) => {
    if (cancelled || stopResolve) return;
    if (event.type !== "message_end") return;
    const message = event.message as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") return;
    if (!textOfMessage(message).includes(args.marker)) return;
    stopResolve = resolveMessageEntryId({
      session: args.session,
      message,
      onFound: (entryId) => {
        args.onFound(entryId);
        cancel();
      },
    });
  });
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    stopResolve?.();
    unsubscribe();
  };
  timer = setTimeout(cancel, args.timeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS);
  return cancel;
}
