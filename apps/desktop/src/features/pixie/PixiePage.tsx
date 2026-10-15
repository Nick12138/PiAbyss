/**
 * Pixie (小精灵) conversation page — v5 标准通道化主题视图。
 *
 * 小精灵当前会话就是 `<agentDir>/workspace/pixie` 工作区里的标准会话：挂载时
 * `pixie.ensureCurrent` 拿到锚点后走 `openSessionAcrossWorkspaces`（内部完成
 * workspace.setCurrent + session.open），此后转写/输入框/统计全部由标准
 * session.snapshot / agent.event 推送驱动——与普通会话同一套机制，仅展示不同：
 *   - 顶部动作（回到最新会话）在 AppTopBar；会话列表在侧边栏左下，
 *     与普通工作区同款（点行留在本页，keepPage）；
 *   - 右侧保留委派面板（pixie.dispatches + pixie.taskTree 轮询，面板是
 *     「工作区 · 会话 → 任务」两层树：只显示短名 + 四态，唯一的动作是定位到
 *     会话里的锚点消息，操作全部留给小精灵）；
 *   - ask 待回复时把输入框发送改道 pixie.reply；
 *   - 内嵌扩展 UI（ask_user_question 问卷等）与子代理对话视图对齐 ChatPage
 *     的挂载方式——小精灵会话是标准会话，两类工具的交互面必须同样可用。
 * 卸载时恢复进入前的工作区（除非用户已手动跳走），并丢弃子代理视图状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { PixieDispatchRecord } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activateWorkspaceAcrossWorkspaces,
  openSessionAcrossWorkspaces,
} from "../../lib/bridge/session-navigation";
import { Transcript } from "../chat/Transcript";
import { Composer } from "../chat/Composer";
import { SessionStatsPills } from "../chat/StatsPills";
import { InlineExtensionUiRequest } from "../chat/InlineExtensionUiRequest";
import { SubagentConversation } from "../subagents/SubagentConversation";
import {
  ComposerRuntimeProvider,
  useComposerRuntime,
  type ComposerRuntime,
} from "../chat/composer-runtime";
import { usePixieViewStore } from "./pixie-store";
import { PixieTaskTree } from "./PixieTaskTree";
import { isSamePixiePath } from "../../lib/pixie-path";

const DISPATCH_POLL_IDLE_MS = 5_000;
const DISPATCH_POLL_ACTIVE_MS = 2_000;

/** 还没走到终态的记录：轮询频率与 ask 改道都按它判定。 */
function isLiveDispatch(record: PixieDispatchRecord): boolean {
  return (
    record.status === "dispatched" ||
    record.status === "queued" ||
    record.status === "paused" ||
    record.status === "awaiting_user"
  );
}

export function PixiePage() {
  const t = useT();
  // 依赖 host 的“实例标识”而不是 host 对象：会话切换（session.open）会
  // 更新 host 的 sessionId/sessionRevision 身份字段并产生新对象引用，若
  // effect 依赖 host 对象，用户在小精灵页里手动切换会话会被 mount-acquire
  // 立即拉回锚点会话（“切换无效”）。hostInstanceId 只在宿主实例真正变化
  // （首次就绪 / 宿主重启）时改变。
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? []);
  const activeSubagentNodeId = useAppStore((s) => s.activeSubagentNodeId);
  const current = usePixieViewStore((s) => s.current);
  const dispatches = usePixieViewStore((s) => s.dispatches);
  const taskTree = usePixieViewStore((s) => s.taskTree);
  const error = usePixieViewStore((s) => s.error);
  const refreshDispatches = usePixieViewStore((s) => s.refreshDispatches);
  const pushContext = usePixieViewStore((s) => s.pushContext);

  const [acquiring, setAcquiring] = useState(true);
  const [acquireFailed, setAcquireFailed] = useState(false);
  /** 进入 pixie 页前的工作区 cwd；null = 之前没有活动工作区（卸载时不恢复）。 */
  const prevCwdRef = useRef<string | null>(null);
  /**
   * 已为其发起过锚定获取的宿主实例。React StrictMode 在 dev 下会「挂载 effect →
   * 立即清理 → 再跑一次」，于是进 pixie 页会并发跑两次 acquire：两次都发
   * workspace.setCurrent（同一 cwd），宿主侧必然撞一次 SERVICE_GRAPH_BUSY，前端
   * workspaceSwitchTarget 槽位又互相踩，慢的那次报 blocked → 页面闪「暂不可用」。
   * 生产构建没有这次重放，所以该症状只在 dev 复现。重放携带同一个 hostInstanceId，
   * 据此跳过；宿主重启（id 变化）时照常重新锚定。
   */
  const acquiredHostInstanceRef = useRef<string | null>(null);

  /**
   * 锚点获取 + 会话打开。幂等：会话已激活时 openSessionAcrossWorkspaces 快速
   * 返回 already-active；segmentChanged 事件（换段开新会话）触发重跑即可。
   */
  const acquire = useCallback(async () => {
    const pixie = await usePixieViewStore.getState().ensureCurrent();
    if (!pixie) {
      setAcquireFailed(true);
      return;
    }
    setAcquireFailed(false);
    const outcome = await openSessionAcrossWorkspaces({
      cwd: pixie.cwd,
      sessionId: pixie.sessionId,
      sessionPath: pixie.sessionPath,
      // 切换是阻塞式的（openSessionAcrossWorkspaces 自己保证）：切完紧接着
      // session.open，不能吃 pending shell——shell 期 servicesReady=false，
      // session.open 直接 AGENT_NOT_READY，就是「每次进小精灵页都提示暂不可用、
      // 手动重试才好」的根因之一。等待期间本页本来就有加载态。
      quiet: true,
    });
    if (outcome.status === "opened" || outcome.status === "already-active") {
      setAcquiring(false);
    } else {
      setAcquireFailed(true);
    }
  }, []);

  // Known-workspace push: on mount and whenever the list changes.
  useEffect(() => {
    void pushContext(knownWorkspaces);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push on identity change of the list
  }, [knownWorkspaces]);

  // Mount acquisition (re-run if the Host wasn't ready at first mount, or when
  // the Host instance is replaced). Same-instance session switches (the user
  // picking a session in the sessions dialog) must NOT re-run this — they
  // would yank the transcript back to the anchor session.
  useEffect(() => {
    if (!hostInstanceId) return;
    // Skip the StrictMode effect replay (see acquiredHostInstanceRef).
    if (acquiredHostInstanceRef.current === hostInstanceId) return;
    acquiredHostInstanceRef.current = hostInstanceId;
    if (prevCwdRef.current === null) {
      // 记录进入前的工作区；已是 pixie 工作区（如冷启动直落 pixie 页）则不恢复。
      const before = useAppStore.getState().workspace?.canonicalCwd ?? null;
      const pixieCwd = usePixieViewStore.getState().current?.cwd;
      prevCwdRef.current = before && !isSamePixiePath(before, pixieCwd) ? before : null;
    }
    void acquire();
  }, [hostInstanceId, acquire]);

  // Leaving the pixie page: hand the active workspace back so the chat page
  // keeps showing whatever the user had before. Skipped when the user already
  // navigated elsewhere themselves.
  useEffect(() => {
    return () => {
      // 子代理视图是全局 store 状态：离开 pixie 页时丢弃，避免把小精灵会话
      // 的子代理对话残留到 chat 页（那边有自己的 SubagentConversation 与
      // 面包屑，语境完全不同）。
      if (useAppStore.getState().activeSubagentNodeId) {
        useAppStore.getState().setActiveSubagent(null);
      }
      const pixieCwd = usePixieViewStore.getState().current?.cwd;
      const before = prevCwdRef.current;
      if (!before || !pixieCwd) return;
      if (!isSamePixiePath(useAppStore.getState().workspace?.canonicalCwd, pixieCwd)) return;
      // 用户是「点了另一个工作区」离开本页的：WorkspacePicker 先占
      // workspaceSwitchTarget 再 setPage，卸载发生在 workspace.setCurrent 的
      // 响应落地之前，上面那条非 pixie 守卫此时还看不见新工作区。这里必须让路：
      // 两次并发 setCurrent 各自生成新 workspaceId 并 bump revision，后提交的一方
      // 会让先提交那方的 UI 身份立刻过期（选择器弹「界面状态已过期」），宿主还会
      // 用后来者取消在飞的构建（workspace-lifecycle 的 supersede 分支）。
      if (useAppStore.getState().workspaceSwitchTarget !== null) return;
      void activateWorkspaceAcrossWorkspaces(before, { quiet: true });
    };
  }, []);

  // Callback/ask/stale events refresh the dispatch panel.
  useEffect(() => {
    if (!hostInstanceId) return;
    return hostClient.onEvent((event) => {
      if (
        event.event === "pixie.reportReceived" ||
        event.event === "pixie.askReceived" ||
        event.event === "pixie.staleWarning"
      ) {
        void refreshDispatches();
      }
    });
  }, [hostInstanceId, refreshDispatches]);

  useEffect(() => {
    if (!hostInstanceId) return;
    return hostClient.onEvent((event) => {
      if (event.event === "pixie.segmentChanged") void acquire();
    });
  }, [hostInstanceId, acquire]);

  /**
   * 面板归属会话 = 用户当前打开的那个小精灵会话（会话弹窗里切换后立即跟随）。
   * 会话还没打开时退回锚点。注意不能直接用锚点：用户在弹窗里翻历史会话时
   * 锚点不变，那样面板会一直显示旧会话的委派。
   */
  const panelSessionId = session?.sessionId ?? current?.sessionId ?? null;

  // Dispatch polling: fast while anything is live, slow otherwise. 切会话
  // （panelSessionId 变化）时 effect 重跑，面板立即改为新会话的关联委派。
  const hasActiveDispatch = useMemo(() => dispatches.some(isLiveDispatch), [dispatches]);
  useEffect(() => {
    if (!hostInstanceId) return;
    void refreshDispatches(panelSessionId);
    const timer = setInterval(
      () => void refreshDispatches(),
      hasActiveDispatch ? DISPATCH_POLL_ACTIVE_MS : DISPATCH_POLL_IDLE_MS,
    );
    return () => clearInterval(timer);
  }, [hostInstanceId, panelSessionId, hasActiveDispatch, refreshDispatches]);

  const awaitingDispatch = useMemo(
    () => dispatches.find((d) => d.status === "awaiting_user") ?? null,
    [dispatches],
  );

  /**
   * 输入框运行时：默认实现（读 app store → agent.prompt/steer）。唯一覆写：
   * 有 ask 待回复时，发送改道 pixie.reply（与 v4 的 reply-mode 行为一致）。
   * 这也是面板不再放回复框的原因——用户本来就坐在小精灵会话里，直接说就行。
   */
  const baseRuntime = useComposerRuntime();
  const runtime = useMemo<ComposerRuntime>(() => {
    if (!awaitingDispatch) return baseRuntime;
    return {
      ...baseRuntime,
      send: async ({ text }) => {
        const ok = await usePixieViewStore.getState().reply(awaitingDispatch.id, text);
        return ok
          ? { ok: true }
          : { ok: false, error: usePixieViewStore.getState().error ?? "reply failed" };
      },
    };
  }, [baseRuntime, awaitingDispatch]);

  // 标准会话视图的就绪条件：锚点拿到且活动工作区确实是 pixie 工作区。
  const ready =
    !acquiring &&
    !acquireFailed &&
    current !== null &&
    isSamePixiePath(workspace?.canonicalCwd, current.cwd) &&
    session !== null;

  if (acquireFailed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Sparkles size={20} className="text-primary" />
        <p className="text-sm text-danger">{error ?? t("pixieUnavailable")}</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-overlay"
          onClick={() => {
            setAcquiring(true);
            setAcquireFailed(false);
            void acquire();
          }}
        >
          {t("pixieRetryAcquire")}
        </button>
      </div>
    );
  }

  if (acquiring || !ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const isNewConversation = Boolean(session && session.messages.length === 0 && session.isIdle);

  return (
    <div className="@container flex h-full min-w-0 flex-col" data-pixie-page>
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        {/* Conversation (70%) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:flex-[7]">
          {activeSubagentNodeId ? (
            /* Subagent view takeover，与 ChatPage 同款：整块对话区属于选中
             * run（自带转写与 composer），主会话转写/输入框仍挂在 store
             * 后面；顶栏面包屑（AppTopBar pixie 分支）负责返回主会话。 */
            <SubagentConversation />
          ) : (
            <>
              {isNewConversation ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                  <Sparkles size={20} className="text-primary" />
                  <p className="text-sm font-medium">{t("pixieEmptyTitle")}</p>
                  <p className="max-w-sm text-xs text-muted">{t("pixieEmptyHint")}</p>
                </div>
              ) : (
                <Transcript />
              )}
              {/* 内嵌扩展 UI（ask_user_question 问卷等）：不挂它时提问请求
               * 照样会进 store 并把 Composer 锁进 decisionBlocked，用户却
               * 看不到问题卡片——死等到超时。与 ChatPage 同位（内容与输入框
               * 之间）。 */}
              <InlineExtensionUiRequest />
              {/* 四周留白全部交给共享 Composer 自己的 footer（`px-5 pb-5 pt-2`，
               * 统计药丸在位时 footer 底部收到 5px），与 ChatPage 完全同一套
               * 度量。这里曾叠着 px-3/sm:px-6 + pt-2 + pb-3/sm:pb-5，是小精灵
               * V1 自带输入框时代的残留，v5 复用 Composer 后就成了双份间距。 */}
              <div className="shrink-0">
                {error && <p className="mb-2 px-5 text-xs text-danger">{error}</p>}
                <ComposerRuntimeProvider runtime={runtime}>
                  <Composer inputTestId="pixie-input" />
                  <SessionStatsPills />
                </ComposerRuntimeProvider>
              </div>
            </>
          )}
        </div>

        {/* Delegation panel (30%)：「工作区 · 会话 → 任务」两层，只有短名 + 四态；
         * 唯一的动作是行尾定位按钮，把用户送回会话里的锚点消息。 */}
        <div className="hidden min-h-0 flex-col border-l border-border @3xl:flex @3xl:w-[30%]">
          <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted">
            {t("pixieDispatchPanelTitle")}
          </div>
          <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto p-3">
            <PixieTaskTree groups={taskTree} />
          </div>
        </div>
      </div>
    </div>
  );
}
