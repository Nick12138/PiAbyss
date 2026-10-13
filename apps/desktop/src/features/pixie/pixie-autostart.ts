/**
 * 小精灵自启动（app 级，App.tsx 挂载一次）。
 *
 * 宿主就绪且启动流程落定后，后台调用一次 `pixie.ensureCurrent`：Host 侧会
 * 确保小精灵工作区目录、后台图（ensureBackgroundGraph）与当前会话段就绪并
 * 驻留——即「打开软件自动启动小精灵工作区，并保持活跃」。此后点击侧边栏
 * 「小精灵」即时可用，不需要先切到 pixie 工作区再等它冷启动；工作区列表
 * 也据此（pixie-store.current.cwd）把 pixie 工作区从常规列表里过滤掉。
 *
 * 插件被停用时 Host 直接拒绝（pixie.* 方法全部有 gate，无任何副作用），
 * 这里按失败处理并有限重试后放弃；插件启用/宿主重启（hostInstanceId 变化）
 * 后会重新拉起。与 TG 桥的 bootstrapTelegramHost 同一思想：外部通道工作区
 * 在后台保持活跃，不依赖前台。
 */
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";

/** 同一宿主实例上的最大尝试次数（瞬时失败如建图忙；防停用场景反复打点）。 */
const MAX_ATTEMPTS_PER_HOST = 3;

export function startPixieAutostart(): () => void {
  let ensuredHostId: string | null = null;
  let attempts = 0;
  let inFlight = false;

  const tryEnsure = async (): Promise<void> => {
    const state = useAppStore.getState();
    const hostId = state.host?.hostInstanceId ?? null;
    if (!hostId || hostId === ensuredHostId || inFlight) return;
    // 启动/恢复流程未落定时不抢跑（ensureCurrent 会建图，避开恢复窗口）。
    if (state.connecting || state.rehydrating || state.desynchronized || state.hostFatal) return;
    inFlight = true;
    try {
      const pixie = await usePixieViewStore.getState().ensureCurrent();
      if (pixie) {
        ensuredHostId = hostId;
        attempts = 0;
        // 让小精灵从启动起就知道工作区清单（pixie 页挂载时还会再推一次）。
        void usePixieViewStore
          .getState()
          .pushContext(state.desktopSettings?.knownWorkspaces ?? []);
      } else if (hostId === useAppStore.getState().host?.hostInstanceId) {
        // 只为同一宿主实例计数；宿主已换代则交由下一轮处理。
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS_PER_HOST) {
          ensuredHostId = hostId; // 本宿主实例内放弃（典型为插件被停用）
          attempts = 0;
        }
      }
    } finally {
      inFlight = false;
    }
  };

  void tryEnsure();
  return useAppStore.subscribe(() => void tryEnsure());
}
