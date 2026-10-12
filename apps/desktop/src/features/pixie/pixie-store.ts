/**
 * Pixie workspace view store — shared state for the single-conversation
 * PixiePage (v4 工作区化): segment timeline + delegation registry + the
 * ask-pending reply mode, with thin actions over the pixie.* host methods.
 * Modeled after telegram-view-store (zustand + hostClient).
 */
import { create } from "zustand";
import type { PixieAgentState } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";

const STATE_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;

type PixieViewState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  state: PixieAgentState | null;
  refresh: () => Promise<void>;
  /** Send a user message to the current segment (auto pixie.reply when an
   *  ask is pending — the composer switches to reply mode). */
  send: (text: string) => Promise<boolean>;
  /** Answer an awaiting ask explicitly (inline reply in the dispatch panel). */
  reply: (dispatchId: string, text: string) => Promise<boolean>;
  /** 打个盹: instruct the pixie to rest; Host force-finalizes on refusal. */
  nap: () => Promise<boolean>;
  /** Push the known-workspace list (mount + knownWorkspaces changes). */
  pushContext: (workspaces: string[]) => Promise<void>;
  /** v4.1 插话：向进行中委派补充/修正（append）或要进度检查点（checkpoint）。 */
  interject: (
    dispatchId: string,
    text: string,
    mode?: "append" | "checkpoint",
    after?: "continue" | "wait",
  ) => Promise<boolean>;
  /** v4.1 叫停：运行中中断 / 排队中取消，回执明确。 */
  stopDispatch: (dispatchId: string) => Promise<boolean>;
  /** v4.1 重试：resume=原地续跑；redispatch=重派；缺省 Host 自动判定。 */
  retryDispatch: (dispatchId: string, mode?: "resume" | "redispatch") => Promise<boolean>;
};

export const usePixieViewStore = create<PixieViewState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  state: null,

  refresh: async () => {
    const host = useAppStore.getState().host;
    if (!host) return;
    if (get().loading) return;
    set({ loading: true });
    try {
      const response = await hostClient.request("pixie.state", hostContext(host), null, STATE_TIMEOUT_MS);
      if (!response.ok) {
        set({
          loading: false,
          loaded: true,
          error: response.error?.message ?? "pixie unavailable",
        });
        return;
      }
      set({ loading: false, loaded: true, error: null, state: response.result });
    } catch (error) {
      set({
        loading: false,
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  send: async (text) => {
    const host = useAppStore.getState().host;
    if (!host || !text.trim()) return false;
    const current = get().state;
    // Reply-mode: an ask is awaiting the user's answer — route to pixie.reply.
    const awaiting = current?.dispatches.find((d) => d.status === "awaiting_user");
    try {
      const response = awaiting
        ? await hostClient.request(
            "pixie.reply",
            hostContext(host),
            { dispatchId: awaiting.id, text: text.trim() },
            SEND_TIMEOUT_MS,
          )
        : await hostClient.request(
            "pixie.send",
            hostContext(host),
            { text: text.trim() },
            SEND_TIMEOUT_MS,
          );
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie send failed" });
        return false;
      }
      void get().refresh();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
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
      void get().refresh();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  nap: async () => {
    const host = useAppStore.getState().host;
    if (!host) return false;
    try {
      const response = await hostClient.request("pixie.newSegment", hostContext(host), null, SEND_TIMEOUT_MS);
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie nap failed" });
        return false;
      }
      void get().refresh();
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
      await hostClient.request("pixie.setContext", hostContext(host), { workspaces }, SEND_TIMEOUT_MS);
    } catch {
      /* context push is best-effort */
    }
  },

  interject: async (dispatchId, text, mode = "append", after) => {
    const host = useAppStore.getState().host;
    if (!host || !text.trim()) return false;
    try {
      const response = await hostClient.request(
        "pixie.interject",
        hostContext(host),
        { dispatchId, text: text.trim(), mode, ...(mode === "checkpoint" && after ? { after } : {}) },
        SEND_TIMEOUT_MS,
      );
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie interject failed" });
        return false;
      }
      // result.ok=false（排队中/已结束不可插话等）转为可读错误提示。
      const result = response.result as { ok?: boolean; error?: string | null };
      if (result && result.ok === false) {
        set({ error: result.error ?? "插话未送达" });
        return false;
      }
      void get().refresh();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  stopDispatch: async (dispatchId) => {
    const host = useAppStore.getState().host;
    if (!host) return false;
    try {
      const response = await hostClient.request(
        "pixie.stopDispatch",
        hostContext(host),
        { dispatchId },
        SEND_TIMEOUT_MS,
      );
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie stop failed" });
        return false;
      }
      void get().refresh();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  retryDispatch: async (dispatchId, mode) => {
    const host = useAppStore.getState().host;
    if (!host) return false;
    try {
      const response = await hostClient.request(
        "pixie.retryDispatch",
        hostContext(host),
        { dispatchId, ...(mode ? { mode } : {}) },
        SEND_TIMEOUT_MS,
      );
      if (!response.ok) {
        set({ error: response.error?.message ?? "pixie retry failed" });
        return false;
      }
      const result = response.result as { ok?: boolean; error?: string | null };
      if (result && result.ok === false) {
        set({ error: result.error ?? "重试失败" });
        return false;
      }
      void get().refresh();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
}));
