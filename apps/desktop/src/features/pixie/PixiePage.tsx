/**
 * Pixie (小精灵) conversation page — v5 标准通道化主题视图。
 *
 * 小精灵当前会话就是 `<agentDir>/workspace/pixie` 工作区里的标准会话：挂载时
 * `pixie.ensureCurrent` 拿到锚点后走 `openSessionAcrossWorkspaces`（内部完成
 * workspace.setCurrent + session.open），此后转写/输入框/统计全部由标准
 * session.snapshot / agent.event 推送驱动——与普通会话同一套机制，仅展示不同：
 *   - 顶部动作（回到最新会话）在 AppTopBar；会话列表在侧边栏左下，
 *     与普通工作区同款（点行留在本页，keepPage）；
 *   - 右侧是可展开 / 折叠的「随行面板」（PixieSidePanel）：顶部三块横排页签（方寸间 /
 *     周期计划 / 委派任务），一次只看一块。「委派任务」的数据就在本页轮询
 *     （pixie.dispatches + pixie.taskTree），展开后是「工作区 · 会话 → 任务」两层树：
 *     只显示短名 + 四态，唯一的动作是定位到会话里的锚点消息，操作全部留给小精灵；
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
import { PixieSidePanel } from "./PixieSidePanel";
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
  /** 有人正在切工作区（选择器 / 会话跳转）：别在这个窗口里再抢一次，否则两边互相作废。 */
  const workspaceSwitchPending = useAppStore((s) => s.workspaceSwitchTarget !== null);
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

  /**
   * 工作区被人从脚下换走时重新锚定。本页只能坐在小精灵工作区上（转写、发送、
   * 面板全按这个前提），而「跳转失败但工作区已经被切走」这类路径会让 here
   * 一直不成立——页面就停在加载态，用户看到的就是一片空白。acquire 是幂等的：
   * 工作区已经回来的话 openSessionAcrossWorkspaces 直接返回 already-active，
   * 所以这里发现「锚定已完成却没坐在小精灵工作区上」就再锚一次，切回来即停。
   */
  const pixieAnchorCwd = current?.cwd ?? null;
  const workspaceStrayed =
    !acquiring &&
    !acquireFailed &&
    !workspaceSwitchPending &&
    pixieAnchorCwd !== null &&
    !isSamePixiePath(workspace?.canonicalCwd, pixieAnchorCwd);
  useEffect(() => {
    if (!hostInstanceId || !workspaceStrayed) return;
    void acquire();
  }, [hostInstanceId, workspaceStrayed, acquire]);

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
      {/* 对话与随行面板**永远同排**：窄容器不再把面板 `display:none`，而是由面板自己
       * 按 672px 阈值收起（负 margin 滑出，见 `PixieSidePanel`）。换成这样是为了让
       * 「自动收起」和手动折叠共用一次动画——`display:none` 没有中间态，跨断点必然硬切。 */}
      <div className="flex min-h-0 flex-1 flex-row">
        {/* Conversation（面板收起时占满） */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeSubagentNodeId ? (
            /* Subagent view takeover，与 ChatPage 同款：整块对话区属于选中
             * run（自带转写与 composer），主会话转写/输入框仍挂在 store
             * 后面；顶栏面包屑（AppTopBar pixie 分支）负责返回主会话。 */
            <SubagentConversation />
          ) : (
            <>
              {/* 空会话不再自画一套空状态：招呼语复用 Composer 的 welcome 机制
               * （`welcomeWorkspaceName` 一给，Composer 自己接管整块高度居中排布
               *  logo + 按时段抽的问候语），与普通工作区新建会话同一份文案池和
               *  同一套度量。Transcript 在 welcome 态不挂——它和 Composer 都要
               *  flex-1，同排必然抢高度。 */}
              {!isNewConversation && <Transcript />}
              {/* 内嵌扩展 UI（ask_user_question 问卷等）：不挂它时提问请求
               * 照样会进 store 并把 Composer 锁进 decisionBlocked，用户却
               * 看不到问题卡片——死等到超时。与 ChatPage 同位（内容与输入框
               * 之间）。 */}
              <InlineExtensionUiRequest />
              {/* 四周留白全部交给共享 Composer 自己的 footer（docked `px-5 pb-5 pt-2`，
               * 统计药丸在位时 footer 底部收到 5px），与 ChatPage 完全同一套
               * 度量。这里曾叠着 px-3/sm:px-6 + pt-2 + pb-3/sm:pb-5，是小精灵
               * V1 自带输入框时代的残留，v5 复用 Composer 后就成了双份间距。
               * welcome 态这层必须换成 flex 列并交出剩余高度——Composer 靠
               * `flex-1 justify-center` 把招呼语垂直居中，父层给 `shrink-0`
               * 它就只剩输入框那么高。
               * 不传 Composer 的 `isNewConversation`：那个 prop 带出的是新会话的
               * 工具勾选器，而小精灵的工具面（委派/回调）是与 Host 行为绑定的
               * 契约，不该在这一页被用户手动关掉。 */}
              <div className={isNewConversation ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}>
                {error && <p className="mb-2 px-5 text-xs text-danger">{error}</p>}
                <ComposerRuntimeProvider runtime={runtime}>
                  <Composer
                    inputTestId="pixie-input"
                    welcomeWorkspaceName={isNewConversation ? t("pixieTitle") : undefined}
                    /* 招呼语上面那颗 mark 换成小精灵自己的 Sparkles（侧栏入口、顶栏
                     * 都是这一颗），不复用默认的应用 logo——否则这一页和普通工作区
                     * 的新建会话看起来一模一样，认不出是谁的页面。节点整体替换，
                     * 尺寸与下边距由这里定。 */
                    welcomeMark={<Sparkles size={34} className="mb-4 text-primary" aria-hidden />}
                  />
                  <SessionStatsPills />
                </ComposerRuntimeProvider>
              </div>
            </>
          )}
        </div>

        {/* 随行面板（30%，可展开 / 折叠）：共同小标题 + 可折叠分组。本次只有
         * 「委派任务」一个分组——展开后就是原来的「工作区 · 会话 → 任务」两层
         * 树，唯一的动作仍是行尾定位按钮；插话 / 叫停 / 重试都在会话里说。
         * 开关在顶栏（AppTopBar 的 PixiePanelToggleButton）。 */}
        <PixieSidePanel groups={taskTree} />
      </div>
    </div>
  );
}
