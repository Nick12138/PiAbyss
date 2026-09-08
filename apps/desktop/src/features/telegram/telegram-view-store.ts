import { create } from "zustand";
import type {
  TelegramAssistantConfig,
  TelegramBoundUser,
  TelegramBridgeStatus,
  TelegramProfileSummary,
  TelegramSessionDetail,
  TelegramSessionSummary,
  TelegramThreadsConfig,
  TelegramVoiceConfig,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext, hostContext } from "../../lib/bridge/host-context";
import { bootstrapTelegramHost } from "../../lib/bridge/tauri-transport";
import { useAppStore } from "../../lib/stores/app-store";
import { isSameTelegramPath } from "../../lib/telegram-path";

const TELEGRAM_WORKSPACE_DISPLAY_NAME_KEY = "piabyss.telegram.workspaceDisplayName.v1";

/** Bridge on/off preference, persisted by the settings toggle. Default on. */
const TELEGRAM_BRIDGE_ENABLED_KEY = "piabyss.telegram.bridgeEnabled.v1";

export function loadTelegramBridgePrefEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(TELEGRAM_BRIDGE_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveTelegramBridgePrefEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(TELEGRAM_BRIDGE_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore unavailable localStorage */
  }
}

/** Optional display-name override for the telegram workspace entry. */
export function loadTelegramWorkspaceDisplayName(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(TELEGRAM_WORKSPACE_DISPLAY_NAME_KEY);
    return value?.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function saveTelegramWorkspaceDisplayName(name: string): void {
  try {
    if (name.trim()) {
      globalThis.localStorage?.setItem(TELEGRAM_WORKSPACE_DISPLAY_NAME_KEY, name.trim());
    } else {
      globalThis.localStorage?.removeItem(TELEGRAM_WORKSPACE_DISPLAY_NAME_KEY);
    }
  } catch {
    /* ignore unavailable localStorage */
  }
}

/**
 * Telegram workspace data store.
 *
 * The telegram workspace is a REAL folder workspace (`<agentDir>/workspace/
 * telegram`): entering it switches the host workspace like any folder, so the
 * bridge (`/telegram-connect`) runs in its own session and TG turns never
 * pollute other workspaces. This store holds the plugin config view (token
 * never leaves the host), the read-only session history, and bridge controls
 * (status + programmatic start). Whether the telegram workspace is currently
 * active is derived from the real `workspace.canonicalCwd` (see
 * `useTelegramWorkspaceActive`).
 */

/** Cooldown after an explicit bridge start/stop before auto-start may run
 *  again, so a user who stops the bridge is not immediately overridden. */
const BRIDGE_AUTO_START_COOLDOWN_MS = 30_000;
let lastBridgeActionAt = 0;

function markBridgeAction(): void {
  lastBridgeActionAt = Date.now();
}

/** True while the active host workspace is the dedicated telegram workspace. */
export function useTelegramWorkspaceActive(): boolean {
  const workspace = useAppStore((s) => s.workspace);
  const workspacePath = useTelegramViewStore((s) => s.workspacePath);
  return isSameTelegramPath(workspace?.canonicalCwd ?? null, workspacePath);
}

/**
 * After entering the telegram workspace: starts the bridge automatically when
 * a profile is configured and no live owner is detected. Runs only on an
 * enter transition, so repeated renders cannot loop.
 */
export async function maybeAutoStartTelegramBridge(): Promise<boolean> {
  const store = useTelegramViewStore.getState();
  if (!store.profile?.configured) return false;
  const { host: hostNow } = useAppStore.getState();
  if (!hostNow) return false;
  // The workspace switch may have returned before workspace.changed /
  // session.snapshot events landed; wait briefly for the active session.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const { workspace, session } = useAppStore.getState();
    if (workspace && session) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const { workspace, session } = useAppStore.getState();
  if (!workspace || !session || !isSameTelegramPath(workspace.canonicalCwd, store.workspacePath)) {
    return false;
  }
  await store.refreshBridgeStatus();
  if (useTelegramViewStore.getState().bridgeStatus?.connected) return false;
  if (Date.now() - lastBridgeActionAt < BRIDGE_AUTO_START_COOLDOWN_MS) return false;
  return store.startTelegramBridge();
}

type TelegramViewState = {
  profile: TelegramProfileSummary | null;
  workspacePath: string | null;
  tokenMasked: string | null;
  bound: TelegramBoundUser | null;
  assistant: TelegramAssistantConfig | null;
  voice: TelegramVoiceConfig | null;
  threads: TelegramThreadsConfig | null;
  sessions: TelegramSessionSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  openSessionPath: string | null;
  sessionDetail: TelegramSessionDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  bridgeStatus: TelegramBridgeStatus | null;
  bridgeLoading: boolean;
  exitTelegramWorkspace: () => void;
  /** Immediately reflect a freshly persisted bot profile (add/settings flow). */
  applySavedProfile: (profile: TelegramProfileSummary) => void;
  /** Ensures the telegram workspace folder exists (host-side) and returns its
   *  canonical path, backfilling the config view while at it. */
  ensureTelegramWorkspace: () => Promise<string | null>;
  refreshTelegramSessions: () => Promise<void>;
  refreshTelegramConfig: () => Promise<void>;
  refreshBridgeStatus: () => Promise<void>;
  /** Runs `/telegram-connect` programmatically in the active telegram
   *  workspace's session (SDK executes the extension command without an LLM
   *  turn). No-op unless the telegram workspace is currently active. */
  startTelegramBridge: () => Promise<boolean>;
  /** Bootstraps the bridge's dedicated Host in the background: activates + starts
   *  the telegram workspace Host and runs `/telegram-connect` inside it without
   *  switching the foreground workspace. Unlike `startTelegramBridge`, this does
   *  NOT require the telegram workspace to be the active workspace. */
  startTelegramBridgeInBackground: () => Promise<boolean>;
  /** Runs `/telegram-disconnect` programmatically. Same activation constraint
   *  as `startTelegramBridge`; in Threaded Mode the plugin's confirm dialog
   *  cannot be answered from a detached prompt, so it may no-op there. */
  stopTelegramBridge: () => Promise<boolean>;
  openTelegramSession: (sessionPath: string) => Promise<void>;
  closeTelegramSession: () => void;
  applyTelegramConfig: (
    assistant?: TelegramAssistantConfig | null,
    voice?: TelegramVoiceConfig | null,
    threads?: TelegramThreadsConfig | null,
  ) => Promise<boolean>;
};

export const useTelegramViewStore = create<TelegramViewState>((set, get) => ({
  profile: null,
  workspacePath: null,
  tokenMasked: null,
  bound: null,
  assistant: null,
  voice: null,
  threads: null,
  sessions: [],
  loading: false,
  loaded: false,
  error: null,
  openSessionPath: null,
  sessionDetail: null,
  detailLoading: false,
  detailError: null,
  bridgeStatus: null,
  bridgeLoading: false,

  exitTelegramWorkspace: () => {
    set({ openSessionPath: null, sessionDetail: null });
    // profile/sessions are kept so re-entering reuses the last snapshot.
  },

  applySavedProfile: (profile) => {
    set({ profile, loaded: true, error: null });
  },

  ensureTelegramWorkspace: async () => {
    const host = useAppStore.getState().host;
    if (!host) return get().workspacePath;
    try {
      const res = await hostClient.request("telegram.getConfig", hostContext(host), null, 15_000);
      if (!res.ok) return get().workspacePath;
      set({
        profile: res.result.default,
        workspacePath: res.result.workspacePath,
        tokenMasked: res.result.tokenMasked ?? null,
        bound: res.result.bound ?? null,
        assistant: res.result.assistant ?? null,
        voice: res.result.voice ?? null,
        threads: res.result.threads ?? null,
      });
      return res.result.workspacePath;
    } catch {
      return get().workspacePath;
    }
  },

  refreshTelegramConfig: async () => {
    const host = useAppStore.getState().host;
    if (!host) return;
    try {
      const res = await hostClient.request("telegram.getConfig", hostContext(host), null, 15_000);
      if (!res.ok) return;
      set({
        profile: res.result.default,
        workspacePath: res.result.workspacePath,
        tokenMasked: res.result.tokenMasked ?? null,
        bound: res.result.bound ?? null,
        assistant: res.result.assistant ?? null,
        voice: res.result.voice ?? null,
        threads: res.result.threads ?? null,
      });
    } catch {
      /* config refresh is best-effort; the entry still works from sessions */
    }
  },

  refreshTelegramSessions: async () => {
    const host = useAppStore.getState().host;
    if (!host || get().loading) return;
    set({ loading: true, error: null });
    try {
      // Also silently re-fetch the currently open session so the transcript
      // reflects newly delivered TG messages, not just the sidebar list.
      const openPath = get().openSessionPath;
      const [listRes, configRes, detailRes] = await Promise.all([
        hostClient.request("telegram.listSessions", hostContext(host), null, 15_000),
        hostClient.request("telegram.getConfig", hostContext(host), null, 15_000),
        openPath
          ? hostClient.request(
              "telegram.getSession",
              hostContext(host),
              { sessionPath: openPath },
              15_000,
            )
          : Promise.resolve(null),
      ]);
      if (!listRes.ok) {
        // Keep the profile-based entry usable even when the session scan
        // fails; the sidebar list will surface the error itself.
        set({
          profile: configRes.ok ? configRes.result.default : null,
          workspacePath: configRes.ok ? configRes.result.workspacePath : null,
          tokenMasked: configRes.ok ? (configRes.result.tokenMasked ?? null) : null,
          loaded: true,
          loading: false,
          error: listRes.error.message ?? "Telegram history unavailable",
        });
        return;
      }
      set({
        sessions: listRes.result.sessions,
        profile: configRes.ok ? configRes.result.default : null,
        workspacePath: configRes.ok ? configRes.result.workspacePath : null,
        tokenMasked: configRes.ok ? (configRes.result.tokenMasked ?? null) : null,
        bound: configRes.ok ? (configRes.result.bound ?? null) : null,
        assistant: configRes.ok ? (configRes.result.assistant ?? null) : null,
        voice: configRes.ok ? (configRes.result.voice ?? null) : null,
        threads: configRes.ok ? (configRes.result.threads ?? null) : null,
        // Keep the open transcript in sync; fall back to the previous
        // snapshot when no session is open or the re-fetch failed.
        sessionDetail: detailRes?.ok ? detailRes.result : get().sessionDetail,
        loaded: true,
        loading: false,
        error: null,
      });
    } catch (err) {
      // Any failure still marks the view loaded so a configured profile can
      // drive the entry; the sidebar surfaces the error itself.
      set({
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  refreshBridgeStatus: async () => {
    const host = useAppStore.getState().host;
    if (!host) return;
    set({ bridgeLoading: true });
    try {
      const res = await hostClient.request("telegram.status", hostContext(host), null, 15_000);
      if (res.ok) set({ bridgeStatus: res.result, bridgeLoading: false });
      else set({ bridgeLoading: false });
    } catch {
      set({ bridgeLoading: false });
    }
  },

  startTelegramBridge: async () => {
    const { host, workspace, session } = useAppStore.getState();
    if (!host || !workspace || !session) return false;
    if (!isSameTelegramPath(workspace.canonicalCwd, get().workspacePath)) return false;
    markBridgeAction();
    try {
      const res = await hostClient.request(
        "agent.prompt",
        activeSessionContext(host, workspace, session),
        { text: "/telegram-connect" },
        30_000,
      );
      if (res.ok) {
        // Polling starts asynchronously inside the host; re-read the owners
        // file shortly after so the status dot reflects the fresh connection.
        setTimeout(() => void get().refreshBridgeStatus(), 1500);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  startTelegramBridgeInBackground: async () => {
    if (!get().profile?.configured) return false;
    const workspacePath = await get().ensureTelegramWorkspace();
    if (!workspacePath) return false;
    markBridgeAction();
    try {
      const ok = await bootstrapTelegramHost(workspacePath);
      if (ok) {
        // The dedicated Host starts polling asynchronously; re-read status
        // shortly after so the dot reflects the fresh connection.
        setTimeout(() => void get().refreshBridgeStatus(), 1500);
      }
      return ok;
    } catch {
      return false;
    }
  },

  stopTelegramBridge: async () => {
    const { host, workspace, session } = useAppStore.getState();
    if (!host || !workspace || !session) return false;
    if (!isSameTelegramPath(workspace.canonicalCwd, get().workspacePath)) return false;
    markBridgeAction();
    try {
      const res = await hostClient.request(
        "agent.prompt",
        activeSessionContext(host, workspace, session),
        { text: "/telegram-disconnect" },
        30_000,
      );
      if (res.ok) {
        setTimeout(() => void get().refreshBridgeStatus(), 1500);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  applyTelegramConfig: async (assistant, voice, threads) => {
    const host = useAppStore.getState().host;
    if (!host) return false;
    const params: {
      assistant?: TelegramAssistantConfig;
      voice?: TelegramVoiceConfig;
      threads?: TelegramThreadsConfig;
    } = {};
    if (assistant !== null && assistant !== undefined) params.assistant = assistant;
    if (voice !== null && voice !== undefined) params.voice = voice;
    if (threads !== null && threads !== undefined) params.threads = threads;
    if (Object.keys(params).length === 0) return true;
    try {
      const res = await hostClient.request(
        "telegram.updateConfig",
        hostContext(host),
        params,
        15_000,
      );
      if (!res.ok) return false;
      set({
        assistant: assistant ?? get().assistant,
        voice: voice ?? get().voice,
        threads: threads ?? get().threads,
      });
      return true;
    } catch {
      return false;
    }
  },

  openTelegramSession: async (sessionPath) => {
    const host = useAppStore.getState().host;
    if (!host) return;
    set({ openSessionPath: sessionPath, detailLoading: true, detailError: null });
    try {
      const res = await hostClient.request(
        "telegram.getSession",
        hostContext(host),
        { sessionPath },
        15_000,
      );
      if (!res.ok) {
        set({ detailError: res.error.message ?? "Failed to open session", detailLoading: false });
        return;
      }
      set({ sessionDetail: res.result, detailLoading: false, detailError: null });
    } catch (err) {
      set({ detailError: err instanceof Error ? err.message : String(err), detailLoading: false });
    }
  },

  closeTelegramSession: () => {
    set({ openSessionPath: null, sessionDetail: null, detailError: null });
  },
}));
