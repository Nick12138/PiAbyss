/**
 * Composer 运行时适配器（ComposerRuntime）。
 *
 * 目标：让普通会话输入框（Composer）与「小精灵」页面复用同一套输入框 UI 与
 * 逻辑。Composer 及其兄弟组件（ModelControls / StatsPills / compaction-actions）
 * 不再各自直接读 app store，而是统一经 `useComposerRuntime()` 取数：
 *   - 有 `<ComposerRuntimeProvider>` 注入时用注入的实现（小精灵）；
 *   - 没有 Provider 时回落到「读 app store」的默认实现，逐字复刻普通会话
 *     既有行为（发送 → agent.prompt/steer/followUp，abort → agent.abort，
 *     模型 → model.list/model.setCurrent，统计/压缩 → compaction-actions）。
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  HostStatusSnapshot,
  PixieModelOption,
  PixieModelSelection,
  PixieSessionRundown,
  SerializableImage,
  SessionSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import { busySendMethod } from "../../lib/busy-send";
import { useAppStore } from "../../lib/stores/app-store";
import { draftKeyForTarget, draftTargetFor } from "../../lib/draft-target";
import { tCurrent } from "../../lib/i18n/use-t";
import {
  abortCompaction as abortCompactionAction,
  requestCompact,
  setAutoCompaction as setAutoCompactionAction,
} from "./compaction-actions";

export type ComposerSendArgs = {
  text: string;
  images: SerializableImage[];
  attachmentIds: string[];
};
export type ComposerSendResult = { ok: true } | { ok: false; error?: unknown };

export type ComposerRuntime = {
  /** 归属：普通会话 or 小精灵。决定个别宿主专属控件是否渲染。 */
  variant: "session" | "pixie";
  host: HostStatusSnapshot | null;
  /** 供输入框显示"忙/压缩中/统计"等用的会话视图。 */
  session: SessionSnapshot | null;
  /** 草稿键（普通会话来自 draftTargetFor，小精灵用固定键 "pixie"）。 */
  draftKey: string | null;
  busySendBehavior?: "steer" | "followUp";
  /** 附件创建、模型列举等 RPC 要用的 context。小精灵传 hostContext(host)。 */
  rpcContext: unknown | null;
  send(args: ComposerSendArgs): Promise<ComposerSendResult>;
  abort(): Promise<void>;
  /** 发送成功后把新快照写回（普通会话 = applySessionSnapshot；小精灵可 no-op）。 */
  applySession(snapshot: SessionSnapshot): void;
  /** 统计与压缩态数据源。普通会话返回 null（沿用 store），小精灵返回 pixie.rundown。 */
  rundown(): Promise<PixieSessionRundown | null>;
  compact(instructions?: string): Promise<{ ok: boolean; error: string | null }>;
  abortCompaction(): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  /** 模型菜单数据源与切换。 */
  listModels(): Promise<{
    models: PixieModelOption[];
    current: PixieModelSelection | null;
  } | null>;
  setModel(
    model: string | null,
    thinkingLevel?: string | null,
  ): Promise<{ ok: boolean; error: string | null }>;
};

const ComposerRuntimeContext = createContext<ComposerRuntime | null>(null);

export function ComposerRuntimeProvider({
  runtime,
  children,
}: {
  runtime: ComposerRuntime;
  children: ReactNode;
}) {
  return <ComposerRuntimeContext.Provider value={runtime}>{children}</ComposerRuntimeContext.Provider>;
}

/** 把 model.list 的 ModelSummary 适配成菜单需要的 PixieModelOption 形状。 */
function toPixieModelOption(model: {
  provider: string;
  providerName?: string;
  modelId: string;
  name: string;
}): PixieModelOption {
  return {
    provider: model.provider,
    ...(model.providerName ? { providerName: model.providerName } : {}),
    id: model.modelId,
    label: model.name || model.modelId,
  };
}

/**
 * 普通会话的默认运行时：全部直接读写 app store，行为与参数化之前一一对应。
 * 只应在「无 Provider」时被 useComposerRuntime() 采用。
 */
function useStoreComposerRuntime(): ComposerRuntime {
  const host = useAppStore((s) => s.host);
  const session = useAppStore((s) => s.session);
  const workspace = useAppStore((s) => s.workspace);
  const busySendBehavior = useAppStore((s) => s.desktopSettings?.busySendBehavior);
  const draftTarget = draftTargetFor(workspace, session);
  const draftKey = draftTarget ? draftKeyForTarget(draftTarget) : null;
  // 忙判定取自渲染时快照：发送时会先写入乐观回显（会把 isIdle 翻成 false），
  // 因此不能等到 send() 再读 store，否则会把 prompt 误判成 steer/followUp。
  const busy = session ? !session.isIdle : false;

  return useMemo<ComposerRuntime>(
    () => ({
      variant: "session",
      host,
      session,
      draftKey,
      busySendBehavior,
      rpcContext:
        host && workspace && session ? activeSessionContext(host, workspace, session) : null,

      send: async ({ text, images, attachmentIds }) => {
        const current = useAppStore.getState();
        if (!current.host || !current.workspace || !current.session) {
          return { ok: false };
        }
        const context = activeSessionContext(current.host, current.workspace, current.session);
        const imageParams = images.length > 0 ? { images } : {};
        const attachmentParams = attachmentIds.length > 0 ? { attachmentIds } : {};
        const res = busy
          ? await hostClient.request(
              busySendMethod(busySendBehavior),
              context,
              { text, ...imageParams, ...attachmentParams },
            )
          : await hostClient.request(
              "agent.prompt",
              context,
              { text, ...imageParams, ...attachmentParams },
              null,
            );
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },

      abort: async () => {
        const current = useAppStore.getState();
        const { host: requestHost, workspace: requestWorkspace, session: requestSession } = current;
        if (!requestHost || !requestWorkspace || !requestSession) return;
        const generation = captureRequestGeneration(requestHost);
        const res = await hostClient.request(
          "agent.abort",
          activeSessionContext(requestHost, requestWorkspace, requestSession),
          null,
        );
        if (
          !isCurrentRequestGeneration(useAppStore.getState().host, generation, { session: true })
        ) {
          return;
        }
        if (!res.ok) {
          current.pushNotification(localizeHostError(res.error, tCurrent), hostErrorLevel(res.error));
          return;
        }
        current.applySessionSnapshot(res.result.session);
        if (res.result.error) current.pushNotification(res.result.error.message, "error");
      },

      applySession: (snapshot) => useAppStore.getState().applySessionSnapshot(snapshot),

      // 普通会话的统计/压缩态沿用 store（session.getStats / agent.* 通道），
      // rundown 只对「小精灵」有意义。
      rundown: async () => null,

      compact: async (instructions) => ({ ok: await requestCompact(instructions), error: null }),
      abortCompaction: async () => {
        await abortCompactionAction();
      },
      setAutoCompaction: async (enabled) => {
        await setAutoCompactionAction(enabled);
      },

      listModels: async () => {
        const current = useAppStore.getState();
        if (!current.host || !current.workspace || !current.session) return null;
        const res = await hostClient.request(
          "model.list",
          activeSessionContext(current.host, current.workspace, current.session),
          null,
        );
        if (!res.ok) return null;
        return {
          models: res.result.models.map(toPixieModelOption),
          current: res.result.current
            ? { provider: res.result.current.provider, id: res.result.current.modelId }
            : null,
        };
      },

      setModel: async (model, thinkingLevel) => {
        const current = useAppStore.getState();
        const { host: requestHost, workspace: requestWorkspace, session: requestSession } = current;
        if (!requestHost || !requestWorkspace || !requestSession) {
          return { ok: false, error: null };
        }
        const context = activeSessionContext(requestHost, requestWorkspace, requestSession);
        if (model) {
          const slash = model.indexOf("/");
          const provider = slash >= 0 ? model.slice(0, slash) : "";
          const modelId = slash >= 0 ? model.slice(slash + 1) : model;
          const res = await hostClient.request("model.setCurrent", context, { provider, modelId });
          if (!res.ok) return { ok: false, error: localizeHostError(res.error, tCurrent) };
          if (res.result.session) useAppStore.getState().applySessionSnapshot(res.result.session);
          useAppStore.getState().setThinkingLevels(res.result.thinkingLevels);
        }
        if (thinkingLevel) {
          const res = await hostClient.request("model.setThinkingLevel", context, {
            level: thinkingLevel,
          });
          if (!res.ok) return { ok: false, error: localizeHostError(res.error, tCurrent) };
          useAppStore.getState().applySessionSnapshot(res.result);
        }
        return { ok: true, error: null };
      },
    }),
    [host, session, workspace, draftKey, busy, busySendBehavior],
  );
}

/**
 * 取当前 Composer 运行时。
 *
 * 必须在组件顶层调用（内部含 store 订阅）。无 Provider 时返回读取 app store
 * 的默认实现，因此普通会话页无需任何包裹即可保持既有行为。
 */
export function useComposerRuntime(): ComposerRuntime {
  const provided = useContext(ComposerRuntimeContext);
  // 无 Provider 时的回落实现。始终调用以保持 Hook 顺序稳定（小精灵场景下
  // 订阅开销可忽略）。
  const fallback = useStoreComposerRuntime();
  return provided ?? fallback;
}
