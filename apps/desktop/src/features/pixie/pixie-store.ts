/**
 * Pixie workspace view store — v5 标准通道化之后的前端残余状态。
 *
 * 会话本体（转写/发送/统计/模型）全部走标准 session 通道（app-store 的
 * workspace/session + agent.* RPC），这里只保留小精灵专属的三块：
 *   1. `ensureCurrent` — 取当前 pixie 会话锚点（cwd/sessionId/sessionPath），
 *      页面挂载时据此完成 workspace.setCurrent + session.open；
 *   2. `dispatches` — 委派注册表（pixie.dispatches + pixie.taskTree 分组树）
 *      + 回复 ask（面板只做导航，插话/叫停/重试归小精灵）；
 *   3. `pushContext` — 已知工作区推送。
 */
import { create } from "zustand";
import type { PixieDispatchRecord, PixieTaskTreeWorkspace } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";

const SEND_TIMEOUT_MS = 30_000;
const DISPATCHES_TIMEOUT_MS = 30_000;

type PixieCurrent = {
  cwd: string;
  sessionId: string;
  sessionPath: string;
};

type PixieViewState = {
  current: PixieCurrent | null;
  dispatches: PixieDispatchRecord[];
  /**
   * 委派面板的展示形状：同一批记录的「工作区 → 会话 → 任务」投影（Host 侧
   * 算好短名、四态与跳转锚点，前端只渲染）。与 `dispatches` 同一次轮询刷新。
   */
  taskTree: PixieTaskTreeWorkspace[];
  dispatchesLoaded: boolean;
  dispatchesLoading: boolean;
  error: string | null;
  /** 取当前 pixie 会话锚点（幂等；Host 侧单飞保证不重复建会话）。 */
  ensureCurrent: () => Promise<PixieCurrent | null>;
  /** 拉取委派列表（sessionId = 面板归属的会话；不传 = 沿用上次）。 */
  refreshDispatches: (sessionId?: string | null) => Promise<void>;
  /** Answer an awaiting ask explicitly (inline reply in the dispatch panel). */
  reply: (dispatchId: string, text: string) => Promise<boolean>;
  /** Push the known-workspace list (mount + knownWorkspaces changes). */
  pushContext: (workspaces: string[]) => Promise<void>;
};

/**
 * 面板归属会话（最近一次 refreshDispatches 指定的那个）。放在模块级而不是
 * zustand state：它只是请求参数，参与渲染毫无意义，改它也不该触发重渲。
 */
let panelSessionId: string | null = null;

/** in-flight 期间归属又变了 → 落地后补拉一次（见 refreshDispatches）。 */
let dispatchesRefreshPending = false;

/** 测试用：清掉归属缓存，避免用例之间互相污染。 */
export function resetPixiePanelSessionForTests(): void {
  panelSessionId = null;
  dispatchesRefreshPending = false;
}

export const usePixieViewStore = create<PixieViewState>((set, get) => ({
  current: null,
  dispatches: [],
  taskTree: [],
  dispatchesLoaded: false,
  dispatchesLoading: false,
  error: null,

  ensureCurrent: async () => {
    const host = useAppStore.getState().host;
    if (!host) return null;
    try {
      const response = await hostClient.request(
        "pixie.ensureCurrent",
        hostContext(host),
        null,
        SEND_TIMEOUT_MS,
      );
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie unavailable" });
        return null;
      }
      set({ current: response.result, error: null });
      return response.result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  /**
   * 拉取委派列表。
   *
   * 归属会话：默认取「用户当前打开的小精灵会话」——在会话弹窗里切换会话后
   * 传新的 id 即可让面板立即跟随；不传则复用上次的归属（reply 之后的无声刷新
   * 走这条路），首次调用前则为 null（Host 退回当前段指针）。
   */
  refreshDispatches: async (sessionId?: string | null) => {
    const host = useAppStore.getState().host;
    if (!host) return;
    if (sessionId !== undefined) panelSessionId = sessionId?.trim() || null;
    if (get().dispatchesLoading) {
      // 上一笔请求还在飞：本次归属更新不能丢——请求体是发出时定格的旧归属，
      // 等它落地后必须用新归属补拉一次，否则切会话最长要等一个轮询周期。
      dispatchesRefreshPending = true;
      return;
    }
    set({ dispatchesLoading: true });
    try {
      const response = await hostClient.request(
        "pixie.dispatches",
        hostContext(host),
        // 面板语义：Host 按给定会话返回全量关联委派（活跃跨会话 + 该会话历史）。
        { sessionId: panelSessionId },
        DISPATCHES_TIMEOUT_MS,
      );
      if (!response.ok) {
        set({
          dispatchesLoading: false,
          dispatchesLoaded: true,
          error: response.error?.message ?? "pixie unavailable",
        });
        return;
      }
      // 分组树与列表同源（同一批记录的两种投影），放在同一次轮询里一起拉，
      // 面板与操作按钮读到的永远是同一时刻的状态。树拉取失败不影响列表：
      // 保留上一次投影，宁可旧一点也不要整块空掉。
      let groups: PixieTaskTreeWorkspace[] | null = null;
      try {
        const tree = await hostClient.request(
          "pixie.taskTree",
          hostContext(host),
          { sessionId: panelSessionId },
          DISPATCHES_TIMEOUT_MS,
        );
        if (tree.ok) groups = tree.result.groups;
      } catch {
        /* 树不可用：面板继续用上一次投影 */
      }
      set({
        dispatchesLoading: false,
        dispatchesLoaded: true,
        error: null,
        dispatches: response.result.dispatches,
        ...(groups ? { taskTree: groups } : {}),
      });
    } catch (error) {
      set({
        dispatchesLoading: false,
        dispatchesLoaded: true,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (dispatchesRefreshPending) {
        dispatchesRefreshPending = false;
        void get().refreshDispatches();
      }
    }
  },

  reply: async (dispatchId, text) => {
    const host = useAppStore.getState().host;
    if (!host || !text.trim()) return false;
    try {
      const response = await hostClient.request(
        "pixie.reply",
        hostContext(host),
        { dispatchId, text: text.trim() },
        SEND_TIMEOUT_MS,
      );
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie reply failed" });
        return false;
      }
      void get().refreshDispatches();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  pushContext: async (workspaces) => {
    const host = useAppStore.getState().host;
    if (!host) return;
    try {
      await hostClient.request(
        "pixie.setContext",
        hostContext(host),
        { workspaces },
        SEND_TIMEOUT_MS,
      );
    } catch {
      /* context push is best-effort */
    }
  },
}));
