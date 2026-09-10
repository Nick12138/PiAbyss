import { create } from "zustand";
import type {
  DesktopSettings,
  ExtensionMessageRenderSnapshot,
  SubagentsStatusSnapshot,
  ExtensionUiGroupStatus,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageSnapshot,
  SessionSnapshot,
  SessionTargetContext,
  ToolSnapshot,
  WorkspaceSnapshot,
  HostEventPayloadMap,
  JsonValue,
  ProviderLoginPrompt,
  SessionSummary,
} from "@piabyss/protocol";
import { stripAttachmentReferenceBlocks } from "@piabyss/protocol";
import {
  anchorHostEpoch as epochAnchorHost,
  applyPackageSnapshot as epochApplyPackages,
  applySessionSnapshot as epochApplySession,
  applyWorkspaceSnapshot as epochApplyWorkspace,
  beginHostEpoch as epochBeginHost,
  clearWorkspaceEpoch as epochClearWorkspace,
  emptyEpoch,
  markDesynchronized as epochMarkDesync,
  noteSequence as epochNoteSequence,
  type EpochState,
} from "./epoch-store";
import {
  emptySessionCatalog,
  replaceSessionCatalog as replaceCatalog,
  setSessionRuntimeState as setCatalogRuntimeState,
  updateSessionCatalogInfo as updateCatalogInfo,
  upsertSessionSnapshot as upsertCatalogSnapshot,
  type SessionCatalogState,
  type SessionRuntimeState,
} from "./session-catalog";
import {
  mergeTerminalSnapshots,
  mergeTerminalState,
  readTerminalStates,
  removeTerminalStates,
  type SessionTerminalSnapshot,
  type SessionTerminalState,
  type SessionTerminalStates,
} from "../session-terminal-states";
import { setSidebarPref, sidebarPref } from "../sidebar-prefs";
import type { AppUpdate } from "../updater";
import {
  draftKeyForTarget,
  draftTargetFromRecord,
  type DraftKey,
  type DraftRecord,
  type DraftTarget,
} from "../draft-target";
import {
  alignExtensionUiToSession,
  extensionUiSessionId,
  isExtensionUiRequestExpired,
  registerDecisionGroupRequest,
  settleDecisionGroupRequest,
  type ExtensionDecisionGroupState,
  type ExtensionDecisionStepOutcome,
  type ExtensionUiRequestState,
} from "./extension-ui-state";

export type NavPage = "chat" | "packages" | "settings";

/** Frozen empty map shared as the initial `providerNames` value so unrelated
 *  sessions don't reallocate a new Map on every reset. */
const EMPTY_PROVIDER_NAMES: ReadonlyMap<string, string> = new Map<string, string>();

const EMPTY_SUBAGENTS_STATUS: SubagentsStatusSnapshot = {
  version: 1,
  available: false,
  generatedAt: 0,
  totalActive: 0,
  omitted: 0,
  fleet: [],
  runs: [],
};

function optimisticMessageFingerprint(message: { role: string; content: unknown }): string {
  const content = message.content;
  // Host-injected attachment blocks must not make an otherwise identical
  // authoritative message look different from the pending optimistic row.
  if (typeof content === "string") {
    return JSON.stringify({
      role: message.role,
      text: stripAttachmentReferenceBlocks(content).trim(),
      images: [],
    });
  }
  if (Array.isArray(content)) {
    const text: string[] = [];
    const images: Array<{ data: unknown; mimeType: unknown }> = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const value = part as Record<string, unknown>;
      if (typeof value.text === "string") text.push(value.text);
      if (value.type === "image") {
        images.push({ data: value.data, mimeType: value.mimeType ?? value.mediaType });
      }
    }
    return JSON.stringify({
      role: message.role,
      text: stripAttachmentReferenceBlocks(text.join("\n")).trim(),
      images,
    });
  }
  try {
    return JSON.stringify({ role: message.role, content });
  } catch {
    return `${message.role}:${String(content)}`;
  }
}

/**
 * Keep local optimistic rows across an authoritative snapshot until a matching
 * SDK message has arrived. Snapshots are authoritative for persisted state,
 * but they cannot know about a desktop-only row created after the snapshot was
 * built.
 */
function mergeOptimisticMessages(
  current: SessionSnapshot | null,
  incoming: SessionSnapshot | null,
): SessionSnapshot | null {
  if (
    !current ||
    !incoming ||
    current.sessionId !== incoming.sessionId ||
    current.revision !== incoming.revision
  ) {
    return incoming;
  }

  const pending = current.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => typeof message._optimisticKey === "string");
  if (pending.length === 0) return incoming;

  const committedCounts = new Map<string, number>();
  for (const message of current.messages) {
    if (message._optimisticKey !== undefined) continue;
    const key = optimisticMessageFingerprint(message);
    committedCounts.set(key, (committedCounts.get(key) ?? 0) + 1);
  }
  const incomingCounts = new Map<string, number>();
  for (const message of incoming.messages) {
    const key = optimisticMessageFingerprint(message);
    incomingCounts.set(key, (incomingCounts.get(key) ?? 0) + 1);
  }

  const preserved = pending.filter(({ message }) => {
    if (
      incoming.messages.some((candidate) => candidate._optimisticKey === message._optimisticKey)
    ) {
      return false;
    }
    const key = optimisticMessageFingerprint(message);
    // A matching additional authoritative message means the SDK has already
    // accepted this turn even if the start event was missed by the renderer.
    return (incomingCounts.get(key) ?? 0) <= (committedCounts.get(key) ?? 0);
  });
  if (preserved.length === 0) return incoming;

  const messages = [...incoming.messages];
  let inserted = 0;
  for (const { message, index } of preserved) {
    messages.splice(Math.min(index + inserted, messages.length), 0, message);
    inserted += 1;
  }
  return { ...incoming, messages };
}

// Monotonic arrival order shared across persistent and transient notifications.
let nextNotificationSeq = 0;

/** Transient (info/success) notifications are toast-only; keep a small buffer
 *  beyond MAX_STACKED_TOASTS so rapid pushes don't drop an un-rendered toast. */
const TRANSIENT_NOTIFICATION_CAP = 8;

// 不在状态条展示的插件状态（插件功能保留，仅取消注册显示）
const IGNORED_EXTENSION_STATUS_KEYS: ReadonlySet<string> = new Set([
  "telegram", // @llblab/pi-telegram
  "wechat", // pi-wechat-assistant
  "pi-vision", // my-pi-plugins pi-vision
]);

/** Live view of the single in-flight builtin Provider login flow. */
type ProviderLoginUiState = {
  loginId: string;
  providerId: string;
  authUrl?: { url: string; instructions?: string };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  infos: Array<{ message: string; links?: Array<{ url: string; label?: string }> }>;
  progress?: string;
  prompt: ProviderLoginPrompt | null;
  done?: { ok: boolean; message?: string };
};

type PackageProgressState = HostEventPayloadMap["package.progress"] & {
  lastEventAt: number;
};

type PackageRetryState = {
  method: string;
  params: JsonValue;
};

type ExtensionWidgetState = {
  key: string;
  widget: JsonValue;
  placement?: "aboveEditor" | "belowEditor";
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
};

/** Live ui.custom() panel rendered in the right dock's terminal tab. */
export type ExtensionTerminalState = {
  requestId: string;
  title?: string;
  cols: number;
  rows: number;
  context: SessionTargetContext;
};

export type AppNotification = {
  id: string;
  message: string;
  level: string;
  createdAt: number;
  /** Cleared when the notification center is opened; drives the unread badge. */
  read: boolean;
  /** Monotonic arrival stamp shared across the history and transient toast feeds. */
  seq?: number;
};

/**
 * Aggregated session activity for one workspace, driving its status dot.
 * Priority is red (unacknowledged failure) > green/yellow (busy) > gray
 * (unacknowledged completion) > none.
 */
export type WorkspaceActivity = {
  busy: boolean;
  hasBeenBusy: boolean;
  errorCount: number;
  doneCount: number;
  terminalSessions: Record<string, SessionTerminalSnapshot>;
};

type AppUpdatePhase =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "available"; update: AppUpdate }
  | {
      state: "downloading";
      update: AppUpdate;
      downloadedBytes: number;
      totalBytes: number | null;
    }
  | { state: "installing"; update: AppUpdate };

/** Live membership of one workspace in the Host's bound-workspace set. */
export type BoundWorkspaceInfo = { revision: number; cwd: string };

/**
 * Index a Host status's `boundWorkspaces` list (shared-host multi-workspace)
 * by workspaceId. An absent list (older Hosts) yields an empty map.
 */
function boundWorkspacesFromStatus(
  status: Pick<HostStatusSnapshot, "boundWorkspaces"> | null | undefined,
): Record<string, BoundWorkspaceInfo> {
  const map: Record<string, BoundWorkspaceInfo> = {};
  for (const ref of status?.boundWorkspaces ?? []) {
    map[ref.workspaceId] = { revision: ref.revision, cwd: ref.cwd };
  }
  return map;
}

/**
 * Close the extension terminal panel, restoring the dock to its pre-panel
 * state unless the user toggled the dock manually while the panel was open.
 */
function resetExtensionTerminal(state: {
  extensionTerminal: ExtensionTerminalState | null;
  dockOpen: boolean;
  dockRestoreOnPanelClose: boolean | null;
}): {
  extensionTerminal: null;
  dockOpen: boolean;
  dockRestoreOnPanelClose: null;
} {
  return {
    extensionTerminal: null,
    dockOpen: state.extensionTerminal
      ? (state.dockRestoreOnPanelClose ?? state.dockOpen)
      : state.dockOpen,
    dockRestoreOnPanelClose: null,
  };
}

export type SettingsSection =
  | "general"
  | "appearance"
  | "shortcuts"
  | "providers"
  | "skills"
  | "packages"
  | "plugins"
  | "usage"
  | "host";

/**
 * Workspace-scoped Settings position cache: the last section the user was on
 * (plus per-section scroll offsets) so a generic re-open — the sidebar button
 * or the "open settings" command — returns to where they left off. Written by
 * SettingsPage on unmount, cleared on workspace switch, expired after
 * SETTINGS_NAV_CACHE_TTL_MS. In-memory only; explicit opens (e.g. the auth
 * banner's "providers") never consult it.
 */
export type SettingsNavCache = {
  workspaceId: string;
  section: SettingsSection;
  scroll: Partial<Record<SettingsSection, number>>;
  savedAt: number;
};

/** How long a remembered Settings position stays valid (30 minutes). */
const SETTINGS_NAV_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Restore the remembered Settings section for a generic open. A cache that is
 * still fresh for the current workspace wins; anything stale (timed out or from
 * another workspace) is dropped so the next open lands on "general" again.
 */
function restoreSettingsNavCache(state: {
  settingsNavCache: SettingsNavCache | null;
  workspace: { id: string } | null;
}): Partial<Pick<AppState, "settingsSection" | "settingsNavCache">> {
  const cache = state.settingsNavCache;
  if (!cache) return {};
  const fresh =
    state.workspace !== null &&
    state.workspace.id === cache.workspaceId &&
    Date.now() - cache.savedAt <= SETTINGS_NAV_CACHE_TTL_MS;
  return fresh ? { settingsSection: cache.section } : { settingsNavCache: null };
}

export type AppState = EpochState & {
  page: NavPage;
  /** Section the Settings overlay should open on (null = default "general"). */
  settingsSection: SettingsSection | null;
  /** Last visited Settings position for the current workspace (see SettingsNavCache). */
  settingsNavCache: SettingsNavCache | null;
  /**
   * Set when agent.prompt is rejected with AUTH_REQUIRED: the chat banner
   * points at Settings → Providers. Cleared on dismiss, on the next accepted
   * prompt, and when the provider config revision moves (login/logout/save).
   */
  authBlocked: { providerId: string | null } | null;
  desktopSettings: DesktopSettings | null;
  extensionUiRequest: ExtensionUiRequestState | null;
  extensionUiQueue: ExtensionUiRequestState[];
  extensionDecisionGroups: Record<string, ExtensionDecisionGroupState>;
  extensionStatus: string | null;
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, ExtensionWidgetState>;
  collapsedExtensionWidgetKeys: Record<string, true>;
  extensionWidgetsOpen: boolean;
  lastExtensionWidgetAttentionRunId: string | null;
  extensionTerminal: ExtensionTerminalState | null;
  /** Live pi-subagents projection for the active Pi session. */
  subagentsStatus: SubagentsStatusSnapshot;
  /** Right dock visibility. Auto-opens for extension panels; manual toggles persist. */
  dockOpen: boolean;
  /** Dock state to restore when the auto-opened panel closes (null = user took over). */
  dockRestoreOnPanelClose: boolean | null;
  /** Whether the global left aside is collapsed. Backed by localStorage so it
   *  survives reloads; promoted out of Sidebar-local state so the app-level
   *  top bar can both read and toggle it. */
  sidebarCollapsed: boolean;
  packageProgress: PackageProgressState | null;
  packageRetry: PackageRetryState | null;
  thinkingLevels: string[];
  providerConfigRevision: number;
  /** Provider id -> display name, resolved from the model catalog. Used to render
   *  historical `model_change` session entries with the Provider name rather than
   *  its raw service id (e.g. "天机阁" instead of "8"). */
  providerNames: ReadonlyMap<string, string>;
  setProviderNames: (names: ReadonlyMap<string, string>) => void;
  sessionCatalog: SessionCatalogState;
  /** Last explicit session.runtimeChanged state per session. Session snapshots
   * may arrive first and must not erase the busy-to-terminal event edge. */
  sessionRuntimeStates: Record<string, SessionRuntimeState>;
  /** Workspaces bound to the live Host (active plus parked graphs), keyed by
   *  workspaceId. Fed by HostStatusSnapshot.boundWorkspaces and kept fresh via
   *  workspace snapshots; lets the renderer accept and attribute events from
   *  parked workspaces in shared-host multi-workspace mode without recovery. */
  boundWorkspaces: Record<string, BoundWorkspaceInfo>;
  /** Replace the bound-workspace map with a Host-provided list. An undefined
   *  list (older Hosts / field omitted) is a no-op — absence carries no
   *  information, so it must not clear known bindings. */
  applyBoundWorkspaces: (
    entries: readonly { workspaceId: string; revision: number; cwd: string }[] | undefined,
  ) => void;
  /** Refresh (or add) a single bound workspace entry. */
  upsertBoundWorkspace: (workspaceId: string, revision: number, cwd: string) => void;
  /** Unseen terminal (done/error) markers per session, keyed by workspace. */
  sessionTerminalStates: SessionTerminalStates;
  /** True while the session is pinned to a tree-navigated position, so an empty
   *  transcript at the start of a branch is not mistaken for a new conversation. */
  sessionTreeNavigated: boolean;
  draftTexts: Record<DraftKey, string>;
  draftTargets: Record<DraftKey, DraftTarget>;
  draftEditVersions: Record<DraftKey, number>;
  draftHydratedWorkspace: string | null;
  appUpdatePhase: AppUpdatePhase;
  notifications: AppNotification[];
  /** Toast-only (info/success) notifications that never enter the history. */
  transientNotifications: AppNotification[];
  hostFatal: string | null;
  connecting: boolean;
  rehydrating: boolean;
  /** True while the Providers settings form holds unsaved edits (guards Settings close/nav). */
  providersDirty: boolean;
  providerLogin: ProviderLoginUiState | null;
  beginProviderLogin: (loginId: string, providerId: string) => void;
  applyProviderLoginEvent: (payload: HostEventPayloadMap["provider.loginEvent"]) => void;
  clearProviderLogin: () => void;
  setPage: (page: NavPage) => void;
  openSettingsSection: (section: SettingsSection) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setSettingsNavCache: (cache: SettingsNavCache) => void;
  setAuthBlocked: (blocked: { providerId: string | null } | null) => void;
  setProvidersDirty: (dirty: boolean) => void;
  /** New host epoch: clears workspace/session/packages/tools/extension UI. */
  beginHostEpoch: (host: HostStatusSnapshot) => void;
  /**
   * Recovery-era epoch anchor: adopts the handshaken Host identity and resets
   * the sequence watermark while KEEPING the visible workspace/session/
   * packages/tools snapshots. completeRehydrate replaces them atomically, so
   * the UI never flashes an empty shell mid-recovery.
   */
  anchorHostEpochForRecovery: (host: HostStatusSnapshot) => void;
  /** True when a recovery anchored a DIFFERENT Host instance than the one the
   *  visible session catalog / runtime bookkeeping was built under. Those
   *  records belong to the previous epoch and must be rebuilt (not merged)
   *  when completeRehydrate lands, or sessions that no longer exist on the
   *  new Host linger in the sidebar with phantom running/queued states. */
  epochBookkeepingStale: boolean;
  setHost: (host: HostStatusSnapshot | null) => void;
  applyWorkspaceSnapshot: (ws: WorkspaceSnapshot) => void;
  clearWorkspaceEpoch: () => void;
  setWorkspace: (ws: WorkspaceSnapshot | null) => void;
  applySessionSnapshot: (s: SessionSnapshot | null) => void;
  setSession: (s: SessionSnapshot | null) => void;
  setSessionTreeNavigated: (navigated: boolean) => void;
  applyPackageSnapshot: (p: PackageSnapshot | null) => void;
  applyPackageMutationResult: (result: PackageMutationResult) => void;
  setPackages: (p: PackageSnapshot | null) => void;
  setTools: (t: ToolSnapshot | null) => void;
  setDesktopSettings: (d: DesktopSettings | null) => void;
  setExtensionUiRequest: (r: ExtensionUiRequestState | null) => void;
  enqueueExtensionUiRequest: (r: ExtensionUiRequestState) => void;
  presentCandidateExtensionUiRequest: (r: ExtensionUiRequestState) => void;
  closeExtensionUiRequest: (requestId: string, outcome?: ExtensionDecisionStepOutcome) => void;
  closeExtensionDecisionGroup: (groupKey: string, status: ExtensionUiGroupStatus) => void;
  openExtensionTerminal: (t: ExtensionTerminalState) => void;
  closeExtensionTerminal: (requestId: string) => void;
  setDockOpen: (open: boolean) => void;
  setSidebarCollapsed: (open: boolean) => void;
  toggleSidebar: () => void;
  setExtensionStatus: (key: string | undefined, text: string | null) => void;
  setExtensionMessageRender: (
    entryId: string,
    render: ExtensionMessageRenderSnapshot | null,
  ) => void;
  setSubagentsStatus: (status: SubagentsStatusSnapshot) => void;
  setExtensionWidget: (widget: ExtensionWidgetState) => void;
  toggleExtensionWidgetCollapsed: (key: string) => void;
  setExtensionWidgetsOpen: (open: boolean) => void;
  requestExtensionWidgetAttention: (runId: string, key: string) => void;
  setPackageProgress: (progress: PackageProgressState | null) => void;
  setPackageRetry: (retry: PackageRetryState | null) => void;
  setThinkingLevels: (levels: string[]) => void;
  refreshProviderConfig: () => void;
  replaceSessionCatalog: (workspaceId: string, items: SessionSummary[]) => void;
  clearSessionCatalog: () => void;
  updateSessionCatalogInfo: (sessionId: string, name?: string) => void;
  /**
   * Record an explicit session.runtimeChanged edge. `owningWorkspaceId` is the
   * event envelope's workspaceId: the Session Catalog is only touched for the
   * active workspace, and terminal markers are keyed by the event's owning
   * workspace (falling back to the active one for local optimistic updates).
   */
  setSessionRuntimeState: (
    sessionId: string,
    state: SessionRuntimeState,
    error?: string,
    updatedAt?: number,
    owningWorkspaceId?: string | null,
  ) => void;
  /** Acknowledge a session's terminal (done/error) marker when the user returns to it. */
  acknowledgeSessionTerminalState: (
    workspaceId: string,
    sessionId: string,
    state: SessionTerminalState["state"],
  ) => void;
  mergeSessionTerminalSnapshots: (
    workspaceId: string,
    snapshots: Readonly<Record<string, SessionTerminalSnapshot>>,
  ) => void;
  /** Drop terminal markers for removed sessions (permanent delete / cleanup). */
  removeSessionTerminalStates: (workspaceId: string, sessionIds: readonly string[]) => void;
  /**
   * Live per-workspace session activity (any session running/queued) from the
   * Host pool, keyed by canonical cwd. Drives the workspace list status dots.
   */
  workspaceActivities: Record<string, WorkspaceActivity>;
  setWorkspaceActivities: (activities: Record<string, WorkspaceActivity>) => void;
  setDraftTextLocal: (target: DraftTarget, text: string) => number;
  mergeHydratedDrafts: (
    canonicalCwd: string,
    drafts: readonly DraftRecord[],
    baselineVersions: Readonly<Record<DraftKey, number>>,
  ) => void;
  clearDraftWorkspace: (canonicalCwd: string) => void;
  setAppUpdatePhase: (phase: AppUpdatePhase) => void;
  pushNotification: (message: string, level?: string) => void;
  dismissNotification: (id: string) => void;
  clearNotifications: () => void;
  markNotificationsRead: () => void;
  setHostFatal: (msg: string | null) => void;
  /**
   * Settle into a terminal Host failure: record the fatal message and stop
   * connecting/rehydrating/desync so `startupSettled` can flip true, the
   * startup screen lifts, and the Host-unavailable panel (with its
   * Settings → Restart Host guidance) becomes reachable. Local epoch state is
   * kept so the user retains workspace/session context behind the panel.
   */
  settleHostFailure: (message: string) => void;
  setConnecting: (v: boolean) => void;
  setRehydrating: (v: boolean) => void;
  /** Requested cwd while a workspace switch is in flight; drives switch feedback UI. */
  workspaceSwitchTarget: string | null;
  setWorkspaceSwitchTarget: (target: string | null) => void;
  markDesynchronized: (reason: string) => void;
  noteSequence: (sequence: number) => "apply" | "drop" | "gap";
  completeRehydrate: (snap: {
    host?: HostStatusSnapshot | null;
    workspace?: WorkspaceSnapshot | null;
    session?: SessionSnapshot | null;
    packages?: PackageSnapshot | null;
    tools?: ToolSnapshot | null;
    /** Authoritative event watermark captured with the Host recovery snapshot. */
    lastSequence?: number;
  }) => void;
  clearHostEpoch: (reason: string) => void;
};

function epochSlice(s: AppState): EpochState {
  return {
    host: s.host,
    workspace: s.workspace,
    session: s.session,
    packages: s.packages,
    tools: s.tools,
    desynchronized: s.desynchronized,
    desyncReason: s.desyncReason,
    lastSequence: s.lastSequence,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "chat",
  settingsSection: null,
  settingsNavCache: null,
  authBlocked: null,
  ...emptyEpoch(),
  desktopSettings: null,
  extensionUiRequest: null,
  extensionUiQueue: [],
  extensionDecisionGroups: {},
  extensionStatus: null,
  extensionStatuses: {},
  extensionWidgets: {},
  collapsedExtensionWidgetKeys: {},
  extensionWidgetsOpen: false,
  lastExtensionWidgetAttentionRunId: null,
  extensionTerminal: null,
  subagentsStatus: EMPTY_SUBAGENTS_STATUS,
  dockOpen: sidebarPref("piabyss.dock.open"),
  dockRestoreOnPanelClose: null,
  sidebarCollapsed: sidebarPref("piabyss.sidebar.collapsed"),
  packageProgress: null,
  packageRetry: null,
  thinkingLevels: [],
  providerConfigRevision: 0,
  providerNames: EMPTY_PROVIDER_NAMES,
  sessionCatalog: emptySessionCatalog(),
  sessionRuntimeStates: {},
  epochBookkeepingStale: false,
  boundWorkspaces: {},
  sessionTerminalStates: readTerminalStates(),
  workspaceActivities: {},
  sessionTreeNavigated: false,
  draftTexts: {},
  draftTargets: {},
  draftEditVersions: {},
  draftHydratedWorkspace: null,
  appUpdatePhase: { state: "idle" },
  notifications: [],
  transientNotifications: [],
  hostFatal: null,
  connecting: true,
  rehydrating: false,
  providersDirty: false,
  providerLogin: null,
  beginProviderLogin: (loginId, providerId) =>
    set((state) =>
      // API-key flows prompt synchronously, so the loginEvent can outrun the
      // loginStart response; never reset a flow the event stream already began.
      state.providerLogin?.loginId === loginId
        ? {}
        : { providerLogin: { loginId, providerId, infos: [], prompt: null } },
    ),
  applyProviderLoginEvent: (payload) =>
    set((state) => {
      // The host is authoritative: adopt events for flows this client did not
      // start (or whose loginStart response has not resolved yet).
      const current: ProviderLoginUiState =
        state.providerLogin && state.providerLogin.loginId === payload.loginId
          ? state.providerLogin
          : {
              loginId: payload.loginId,
              providerId: payload.providerId,
              infos: [],
              prompt: null,
            };
      const event = payload.event;
      switch (event.kind) {
        case "info":
          return {
            providerLogin: {
              ...current,
              infos: [
                ...current.infos,
                { message: event.message, ...(event.links ? { links: event.links } : {}) },
              ],
            },
          };
        case "auth_url":
          return {
            providerLogin: {
              ...current,
              authUrl: {
                url: event.url,
                ...(event.instructions ? { instructions: event.instructions } : {}),
              },
            },
          };
        case "device_code":
          return {
            providerLogin: {
              ...current,
              deviceCode: {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                ...(event.expiresInSeconds !== undefined
                  ? { expiresInSeconds: event.expiresInSeconds }
                  : {}),
              },
            },
          };
        case "progress":
          return { providerLogin: { ...current, progress: event.message } };
        case "prompt":
          return { providerLogin: { ...current, prompt: event.prompt } };
        case "prompt_cancel":
          return current.prompt?.promptId === event.promptId
            ? { providerLogin: { ...current, prompt: null } }
            : { providerLogin: current };
        case "done":
          return {
            providerLogin: {
              ...current,
              prompt: null,
              done: { ok: event.ok, ...(event.message ? { message: event.message } : {}) },
            },
          };
        default:
          return { providerLogin: current };
      }
    }),
  clearProviderLogin: () => set({ providerLogin: null }),
  setPage: (page) =>
    set((state) => ({
      page,
      ...(page !== state.page ? { extensionWidgetsOpen: false } : {}),
      // Closing Settings (back to chat) drops the section request; the last
      // position itself lives on in settingsNavCache (written by SettingsPage
      // on unmount), so the next generic open can restore it while it is fresh.
      ...(page === "chat"
        ? { settingsSection: null }
        : page === "settings"
          ? restoreSettingsNavCache(state)
          : {}),
    })),
  openSettingsSection: (section) =>
    set((state) => {
      // An explicit section (e.g. the auth banner's "providers") always opens
      // there. "general" is the generic "open settings" (sidebar/command
      // palette) entry, so it consults the position cache like setPage.
      if (section !== "general") {
        return { page: "settings", settingsSection: section, extensionWidgetsOpen: false };
      }
      return { page: "settings", ...restoreSettingsNavCache(state), extensionWidgetsOpen: false };
    }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  setSettingsNavCache: (settingsNavCache) => set({ settingsNavCache }),
  setAuthBlocked: (authBlocked) => set({ authBlocked }),
  setProvidersDirty: (dirty) => set({ providersDirty: dirty }),

  anchorHostEpochForRecovery: (host) => {
    const previous = get().host;
    const hostChanged = previous !== null && previous.hostInstanceId !== host.hostInstanceId;
    set({
      ...epochAnchorHost(epochSlice(get()), host),
      // The visible catalog/runtime records were built under the previous
      // Host epoch. Keep rendering them until completeRehydrate swaps in the
      // fresh snapshot atomically — clearing here would flash the sidebar —
      // but remember to rebuild instead of merge when it does.
      ...(hostChanged ? { epochBookkeepingStale: true } : {}),
    });
  },

  beginHostEpoch: (host) => {
    const next = epochBeginHost(epochSlice(get()), host);
    set({
      ...next,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      collapsedExtensionWidgetKeys: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      providerNames: EMPTY_PROVIDER_NAMES,
      sessionCatalog: emptySessionCatalog(),
      sessionRuntimeStates: {},
      epochBookkeepingStale: false,
      boundWorkspaces: boundWorkspacesFromStatus(host),
      hostFatal: null,
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      providerLogin: null,
      subagentsStatus: EMPTY_SUBAGENTS_STATUS,
    });
  },

  setHost: (host) => {
    if (!host) {
      set({ host: null });
      return;
    }
    const prev = get().host;
    if (!prev || prev.hostInstanceId !== host.hostInstanceId) {
      get().beginHostEpoch(host);
      return;
    }
    set({ host });
  },

  applyWorkspaceSnapshot: (workspace) => {
    const next = epochApplyWorkspace(epochSlice(get()), workspace);
    const previousWorkspace = get().workspace;
    // The settings position cache is workspace-scoped: switching to another
    // workspace (a different id, not a revision bump of the same one) drops it.
    const switchedWorkspace = Boolean(previousWorkspace && previousWorkspace.id !== workspace.id);
    const clearedSession = Boolean(
      previousWorkspace &&
      (previousWorkspace.id !== workspace.id || previousWorkspace.revision !== workspace.revision),
    );
    // The active workspace is always bound to the Host: keep the bound map
    // fresh (shared-host multi-workspace event routing) even when the Host's
    // own boundWorkspaces list has not been observed yet.
    get().upsertBoundWorkspace(workspace.id, workspace.revision, workspace.canonicalCwd);
    set({
      ...next,
      ...(switchedWorkspace ? { settingsNavCache: null } : {}),
      ...(clearedSession ? { sessionCatalog: emptySessionCatalog() } : {}),
      ...(clearedSession
        ? {
            extensionUiRequest: null,
            extensionUiQueue: [],
            extensionDecisionGroups: {},
            extensionStatus: null,
            extensionStatuses: {},
            extensionWidgets: {},
            collapsedExtensionWidgetKeys: {},
            extensionWidgetsOpen: false,
            lastExtensionWidgetAttentionRunId: null,
            ...resetExtensionTerminal(get()),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : {}),
    });
  },

  clearWorkspaceEpoch: () => {
    const next = epochClearWorkspace(epochSlice(get()));
    set({
      ...next,
      settingsNavCache: null,
      sessionCatalog: emptySessionCatalog(),
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      collapsedExtensionWidgetKeys: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      subagentsStatus: EMPTY_SUBAGENTS_STATUS,
    });
  },

  setWorkspace: (workspace) => {
    if (!workspace) {
      get().clearWorkspaceEpoch();
      set({ workspace: null });
      return;
    }
    get().applyWorkspaceSnapshot(workspace);
  },

  applySessionSnapshot: (session) => {
    const current = get();
    const previousSession = current.session;
    const protectedSession = mergeOptimisticMessages(previousSession, session);
    const next = epochApplySession(epochSlice(current), protectedSession);
    // Switching away must not clear a still-busy previous session's live dot:
    // it keeps running in the background, so only a non-busy previous session
    // (idle/error/inactive) is demoted to "inactive". Preserving the busy
    // state also keeps the busy→idle transition that creates the terminal
    // (done/error) marker when the background run eventually settles.
    const previousEntry = previousSession
      ? current.sessionCatalog.entries[previousSession.sessionId]
      : undefined;
    const previousBusy =
      previousEntry?.runtimeState === "running" ||
      previousEntry?.runtimeState === "queued" ||
      previousEntry?.runtimeState === "starting";
    const baseCatalog =
      previousSession && previousSession.sessionId !== session?.sessionId && !previousBusy
        ? setCatalogRuntimeState(current.sessionCatalog, previousSession.sessionId, "inactive")
        : current.sessionCatalog;
    const sessionCatalog =
      session && current.workspace
        ? upsertCatalogSnapshot(baseCatalog, current.workspace.id, session)
        : baseCatalog;
    let sessionTerminalStates = current.sessionTerminalStates;
    if (previousSession && previousSession.sessionId !== session?.sessionId && current.workspace) {
      const prevTerminal = sessionTerminalStates[current.workspace.id]?.[previousSession.sessionId];
      if (prevTerminal && !prevTerminal.acknowledged) {
        sessionTerminalStates = mergeTerminalState(
          sessionTerminalStates,
          current.workspace.id,
          previousSession.sessionId,
          {
            state: prevTerminal.state,
            acknowledged: true,
            ...(prevTerminal.generation !== undefined
              ? { generation: prevTerminal.generation }
              : {}),
          },
        );
      }
    }
    const generationChanged = Boolean(
      previousSession &&
      (!session ||
        previousSession.sessionId !== session.sessionId ||
        previousSession.revision !== session.revision),
    );
    const sessionChanged = Boolean(
      !previousSession || !session || previousSession.sessionId !== session.sessionId,
    );
    const extensionUi = alignExtensionUiToSession(
      current.extensionUiRequest,
      current.extensionUiQueue,
      session?.sessionId ?? null,
    );
    set({
      ...next,
      sessionCatalog,
      ...(sessionTerminalStates !== current.sessionTerminalStates ? { sessionTerminalStates } : {}),
      ...extensionUi,
      ...(sessionChanged ? { sessionTreeNavigated: false } : {}),
      ...(generationChanged
        ? {
            extensionStatus: null,
            extensionStatuses: {},
            extensionWidgets: {},
            collapsedExtensionWidgetKeys: {},
            extensionWidgetsOpen: false,
            lastExtensionWidgetAttentionRunId: null,
            ...resetExtensionTerminal(current),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
            subagentsStatus: EMPTY_SUBAGENTS_STATUS,
          }
        : {}),
    });
  },

  setSession: (session) => {
    get().applySessionSnapshot(session);
  },

  setSessionTreeNavigated: (navigated) => set({ sessionTreeNavigated: navigated }),

  applyPackageSnapshot: (packages) => {
    const next = epochApplyPackages(epochSlice(get()), packages);
    set({
      ...next,
      ...(packages?.mutation?.reconcileRequired ? {} : { packageRetry: null }),
    });
  },

  applyPackageMutationResult: (result) => {
    const previous = get();
    let nextEpoch = epochApplyPackages(epochSlice(previous), result.packageSnapshot);
    const generationChanged = Boolean(
      result.session &&
      previous.session &&
      (previous.session.sessionId !== result.session.sessionId ||
        previous.session.revision !== result.session.revision),
    );
    if (result.session) {
      nextEpoch = epochApplySession(nextEpoch, result.session);
    }
    const sessionCatalog =
      result.session && previous.workspace
        ? upsertCatalogSnapshot(previous.sessionCatalog, previous.workspace.id, result.session)
        : previous.sessionCatalog;
    set({
      ...nextEpoch,
      sessionCatalog,
      ...(generationChanged
        ? {
            extensionUiRequest: null,
            extensionUiQueue: [],
            extensionDecisionGroups: {},
            extensionStatus: null,
            extensionStatuses: {},
            extensionWidgets: {},
            collapsedExtensionWidgetKeys: {},
            extensionWidgetsOpen: false,
            lastExtensionWidgetAttentionRunId: null,
            ...resetExtensionTerminal(previous),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : result.reconcileRequired
          ? {}
          : { packageRetry: null }),
    });
  },

  setPackages: (packages) => {
    get().applyPackageSnapshot(packages);
  },

  setTools: (tools) => set({ tools }),
  setDesktopSettings: (desktopSettings) => set({ desktopSettings }),
  setExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      let queue = state.extensionUiQueue.filter(
        (queued) => !isExtensionUiRequestExpired(queued, now),
      );
      if (request === null) {
        const targetSessionId = state.extensionUiRequest
          ? extensionUiSessionId(state.extensionUiRequest)
          : (state.session?.sessionId ?? null);
        const nextIndex = targetSessionId
          ? queue.findIndex((queued) => extensionUiSessionId(queued) === targetSessionId)
          : -1;
        if (nextIndex < 0) {
          return { extensionUiRequest: null, extensionUiQueue: queue };
        }
        const next = queue[nextIndex]!;
        return {
          extensionUiRequest: next,
          extensionUiQueue: queue.filter((_, index) => index !== nextIndex),
        };
      }
      let active =
        state.extensionUiRequest && !isExtensionUiRequestExpired(state.extensionUiRequest, now)
          ? state.extensionUiRequest
          : null;
      if (!active && queue.length > 0) {
        [active, ...queue] = queue;
      }
      if (isExtensionUiRequestExpired(request, now)) {
        return { extensionUiRequest: active, extensionUiQueue: queue };
      }
      const extensionDecisionGroups = registerDecisionGroupRequest(
        state.extensionDecisionGroups,
        request,
      );
      if (active?.requestId === request.requestId) {
        return { extensionUiRequest: request, extensionUiQueue: queue, extensionDecisionGroups };
      }
      const existingIndex = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (existingIndex >= 0) {
        queue = [...queue];
        queue[existingIndex] = request;
        return { extensionUiRequest: active, extensionUiQueue: queue, extensionDecisionGroups };
      }
      if (!active) {
        return { extensionUiRequest: request, extensionUiQueue: queue, extensionDecisionGroups };
      }
      return {
        extensionUiRequest: active,
        extensionUiQueue: [...queue, request],
        extensionDecisionGroups,
      };
    }),
  enqueueExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      if (isExtensionUiRequestExpired(request, now)) return {};
      const extensionDecisionGroups = registerDecisionGroupRequest(
        state.extensionDecisionGroups,
        request,
      );
      if (state.extensionUiRequest?.requestId === request.requestId) {
        return { extensionUiRequest: request, extensionDecisionGroups };
      }
      const queue = state.extensionUiQueue.filter(
        (queued) => !isExtensionUiRequestExpired(queued, now),
      );
      const existingIndex = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (existingIndex >= 0) {
        const nextQueue = [...queue];
        nextQueue[existingIndex] = request;
        return { extensionUiQueue: nextQueue, extensionDecisionGroups };
      }
      return { extensionUiQueue: [...queue, request], extensionDecisionGroups };
    }),
  presentCandidateExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      if (isExtensionUiRequestExpired(request, now)) return {};
      const extensionDecisionGroups = registerDecisionGroupRequest(
        state.extensionDecisionGroups,
        request,
      );
      let queue = state.extensionUiQueue.filter(
        (queued) =>
          queued.requestId !== request.requestId && !isExtensionUiRequestExpired(queued, now),
      );
      const active =
        state.extensionUiRequest && !isExtensionUiRequestExpired(state.extensionUiRequest, now)
          ? state.extensionUiRequest
          : null;
      if (active && active.requestId !== request.requestId) {
        queue = [active, ...queue.filter((queued) => queued.requestId !== active.requestId)];
      }
      return {
        extensionUiRequest: request,
        extensionUiQueue: queue,
        extensionDecisionGroups,
      };
    }),
  closeExtensionUiRequest: (requestId, outcome = "stale") =>
    set((state) => {
      const active = state.extensionUiRequest;
      if (active?.requestId !== requestId) {
        const queuedIndex = state.extensionUiQueue.findIndex(
          (queued) => queued.requestId === requestId,
        );
        if (queuedIndex < 0) return {};
        const queuedRequest = state.extensionUiQueue[queuedIndex]!;
        return {
          extensionUiQueue: state.extensionUiQueue.filter((_, index) => index !== queuedIndex),
          extensionDecisionGroups: settleDecisionGroupRequest(
            state.extensionDecisionGroups,
            queuedRequest,
            outcome,
          ),
        };
      }

      const now = Date.now();
      const extensionDecisionGroups = settleDecisionGroupRequest(
        state.extensionDecisionGroups,
        active,
        outcome,
      );
      const targetSessionId = extensionUiSessionId(active);
      const queue = state.extensionUiQueue.filter(
        (queued) => queued.requestId !== requestId && !isExtensionUiRequestExpired(queued, now),
      );
      const nextIndex = targetSessionId
        ? queue.findIndex((queued) => extensionUiSessionId(queued) === targetSessionId)
        : -1;
      if (nextIndex < 0) {
        return { extensionUiRequest: null, extensionUiQueue: queue, extensionDecisionGroups };
      }
      return {
        extensionUiRequest: queue[nextIndex]!,
        extensionUiQueue: queue.filter((_, index) => index !== nextIndex),
        extensionDecisionGroups,
      };
    }),
  closeExtensionDecisionGroup: (groupKey, status) =>
    set((state) => {
      const group = state.extensionDecisionGroups[groupKey];
      if (!group) return {};
      const activeRequestStillPresent =
        group.activeRequestId !== null &&
        (state.extensionUiRequest?.requestId === group.activeRequestId ||
          state.extensionUiQueue.some((request) => request.requestId === group.activeRequestId));
      if (!activeRequestStillPresent) {
        const extensionDecisionGroups = { ...state.extensionDecisionGroups };
        delete extensionDecisionGroups[groupKey];
        return { extensionDecisionGroups };
      }
      return {
        extensionDecisionGroups: {
          ...state.extensionDecisionGroups,
          [groupKey]: { ...group, status },
        },
      };
    }),
  openExtensionTerminal: (panel) =>
    set((state) => ({
      extensionTerminal: panel,
      dockOpen: true,
      // Keep the original pre-panel dock state if one panel replaces another.
      dockRestoreOnPanelClose: state.extensionTerminal
        ? state.dockRestoreOnPanelClose
        : state.dockOpen,
    })),
  closeExtensionTerminal: (requestId) =>
    set((state) => {
      if (state.extensionTerminal?.requestId !== requestId) return {};
      return resetExtensionTerminal(state);
    }),
  setDockOpen: (open) =>
    set({
      dockOpen: open,
      // Manual toggle takes over — the panel close no longer restores.
      dockRestoreOnPanelClose: null,
    }),
  setSidebarCollapsed: (open) => {
    setSidebarPref("piabyss.sidebar.collapsed", open);
    set({ sidebarCollapsed: open });
  },
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      setSidebarPref("piabyss.sidebar.collapsed", next);
      return { sidebarCollapsed: next };
    }),
  setExtensionStatus: (key, text) =>
    set((state) => {
      const statusKey = key || "default";
      if (IGNORED_EXTENSION_STATUS_KEYS.has(statusKey)) return {};
      const extensionStatuses = { ...state.extensionStatuses };
      if (text?.trim()) extensionStatuses[statusKey] = text;
      else delete extensionStatuses[statusKey];
      const values = Object.values(extensionStatuses);
      return {
        extensionStatuses,
        extensionStatus: values.length > 0 ? values[values.length - 1] : null,
      };
    }),
  setSubagentsStatus: (subagentsStatus) => set({ subagentsStatus }),
  setExtensionMessageRender: (entryId, render) =>
    set((state) => {
      if (!state.session) return {};
      const extensionMessageRenders = {
        ...(state.session.extensionMessageRenders ?? {}),
      };
      if (render) extensionMessageRenders[entryId] = render;
      else delete extensionMessageRenders[entryId];
      return {
        session: {
          ...state.session,
          ...(Object.keys(extensionMessageRenders).length > 0
            ? { extensionMessageRenders }
            : { extensionMessageRenders: undefined }),
        },
      };
    }),
  setExtensionWidget: (extensionWidget) =>
    set((state) => {
      const key = extensionWidget.key || "default";
      if (extensionWidget.widget === null) {
        const extensionWidgets = { ...state.extensionWidgets };
        const collapsedExtensionWidgetKeys = { ...state.collapsedExtensionWidgetKeys };
        delete extensionWidgets[key];
        delete collapsedExtensionWidgetKeys[key];
        return {
          extensionWidgets,
          collapsedExtensionWidgetKeys,
          ...(Object.keys(extensionWidgets).length === 0 ? { extensionWidgetsOpen: false } : {}),
        };
      }
      return {
        extensionWidgets: {
          ...state.extensionWidgets,
          [key]: { ...extensionWidget, key },
        },
      };
    }),
  toggleExtensionWidgetCollapsed: (key) =>
    set((state) => {
      if (!state.extensionWidgets[key]) return {};
      const collapsedExtensionWidgetKeys = { ...state.collapsedExtensionWidgetKeys };
      if (collapsedExtensionWidgetKeys[key]) delete collapsedExtensionWidgetKeys[key];
      else collapsedExtensionWidgetKeys[key] = true;
      return { collapsedExtensionWidgetKeys };
    }),
  setExtensionWidgetsOpen: (extensionWidgetsOpen) => set({ extensionWidgetsOpen }),
  requestExtensionWidgetAttention: (runId, key) =>
    set((state) => {
      if (state.lastExtensionWidgetAttentionRunId === runId) return {};
      return {
        lastExtensionWidgetAttentionRunId: runId,
        ...(state.page === "chat" && state.extensionWidgets[key]
          ? { extensionWidgetsOpen: true }
          : {}),
      };
    }),
  setPackageProgress: (packageProgress) => set({ packageProgress }),
  setPackageRetry: (packageRetry) => set({ packageRetry }),
  setThinkingLevels: (thinkingLevels) => set({ thinkingLevels: [...thinkingLevels] }),
  setProviderNames: (providerNames) => set({ providerNames: new Map(providerNames) }),
  refreshProviderConfig: () =>
    set((state) => ({ providerConfigRevision: state.providerConfigRevision + 1 })),
  replaceSessionCatalog: (workspaceId, items) =>
    set((state) => ({
      sessionCatalog: replaceCatalog(state.sessionCatalog, workspaceId, items),
    })),
  clearSessionCatalog: () => set({ sessionCatalog: emptySessionCatalog() }),
  updateSessionCatalogInfo: (sessionId, name) =>
    set((state) => ({
      sessionCatalog: updateCatalogInfo(state.sessionCatalog, sessionId, name),
    })),
  applyBoundWorkspaces: (entries) =>
    set(() => {
      // An undefined list means the Host did not report bindings (older pool);
      // absence is not emptiness, so keep whatever is already known.
      if (entries === undefined) return {};
      const boundWorkspaces: Record<string, BoundWorkspaceInfo> = {};
      for (const entry of entries) {
        boundWorkspaces[entry.workspaceId] = { revision: entry.revision, cwd: entry.cwd };
      }
      return { boundWorkspaces };
    }),
  upsertBoundWorkspace: (workspaceId, revision, cwd) =>
    set((state) => {
      const current = state.boundWorkspaces[workspaceId];
      if (current && current.revision === revision && current.cwd === cwd) return {};
      return {
        boundWorkspaces: { ...state.boundWorkspaces, [workspaceId]: { revision, cwd } },
      };
    }),
  setSessionRuntimeState: (sessionId, runtimeState, error, updatedAt, owningWorkspaceId) =>
    set((state) => {
      // A plain idle announcement for a session that was never busy (freshly
      // opened or restored) is not a completion — only a busy→idle transition
      // creates the done marker, so idle restored sessions never get one.
      const previousRuntime = state.sessionRuntimeStates[sessionId];
      const sessionRuntimeStates = {
        ...state.sessionRuntimeStates,
        [sessionId]: runtimeState,
      };
      // The Session Catalog is scoped to the active workspace; shared-host
      // multi-workspace events from parked workspaces keep their own books.
      const activeWorkspaceId = state.workspace?.id;
      const sessionCatalog =
        !activeWorkspaceId || !owningWorkspaceId || owningWorkspaceId === activeWorkspaceId
          ? setCatalogRuntimeState(state.sessionCatalog, sessionId, runtimeState, error, updatedAt)
          : state.sessionCatalog;
      // Terminal markers are keyed by the event's owning workspace so a parked
      // workspace's completion dots its own row instead of the active one.
      const workspaceId = owningWorkspaceId ?? activeWorkspaceId;
      if (!workspaceId) return { sessionCatalog, sessionRuntimeStates };
      let sessionTerminalStates = state.sessionTerminalStates;
      const current = sessionTerminalStates[workspaceId]?.[sessionId];
      if (runtimeState === "running" || runtimeState === "queued") {
        // A new run supersedes any stale unacknowledged terminal marker so a
        // re-run clears a previous failure/completion dot.
        if (current && !current.acknowledged) {
          sessionTerminalStates = mergeTerminalState(
            sessionTerminalStates,
            workspaceId,
            sessionId,
            { state: current.state, acknowledged: true },
          );
        }
      } else if (runtimeState === "error") {
        // Failures record an unacknowledged error marker for both active and
        // background sessions; sending a new command or leaving the session clears it.
        sessionTerminalStates = mergeTerminalState(sessionTerminalStates, workspaceId, sessionId, {
          state: "error",
          acknowledged: false,
        });
      } else if (runtimeState === "idle") {
        const wasBusy =
          previousRuntime === "running" ||
          previousRuntime === "queued" ||
          previousRuntime === "starting";
        // The idle event after an error is the run settling; keep an
        // unacknowledged error marker so a failed session stays red.
        if (current && current.state === "error" && !current.acknowledged) {
          // keep the error marker
        } else if (wasBusy) {
          sessionTerminalStates = mergeTerminalState(
            sessionTerminalStates,
            workspaceId,
            sessionId,
            { state: "done", acknowledged: false },
          );
        }
      }
      return {
        sessionCatalog,
        sessionRuntimeStates,
        ...(sessionTerminalStates !== state.sessionTerminalStates ? { sessionTerminalStates } : {}),
      };
    }),
  acknowledgeSessionTerminalState: (workspaceId, sessionId, state) =>
    set((current) => {
      const entry = current.sessionTerminalStates[workspaceId]?.[sessionId];
      if (entry?.acknowledged) return {};
      return {
        sessionTerminalStates: mergeTerminalState(
          current.sessionTerminalStates,
          workspaceId,
          sessionId,
          {
            state,
            acknowledged: true,
            ...(entry?.generation ? { generation: entry.generation } : {}),
          },
        ),
      };
    }),
  mergeSessionTerminalSnapshots: (workspaceId, snapshots) =>
    set((state) => {
      const sessionTerminalStates = mergeTerminalSnapshots(
        state.sessionTerminalStates,
        workspaceId,
        snapshots,
      );
      return sessionTerminalStates === state.sessionTerminalStates ? {} : { sessionTerminalStates };
    }),
  removeSessionTerminalStates: (workspaceId, sessionIds) =>
    set((state) => {
      const sessionTerminalStates = removeTerminalStates(
        state.sessionTerminalStates,
        workspaceId,
        sessionIds,
      );
      const sessionRuntimeStates = { ...state.sessionRuntimeStates };
      let removedRuntime = false;
      for (const sessionId of sessionIds) {
        if (!(sessionId in sessionRuntimeStates)) continue;
        delete sessionRuntimeStates[sessionId];
        removedRuntime = true;
      }
      return {
        ...(sessionTerminalStates !== state.sessionTerminalStates ? { sessionTerminalStates } : {}),
        ...(removedRuntime ? { sessionRuntimeStates } : {}),
      };
    }),
  setWorkspaceActivities: (workspaceActivities) => set({ workspaceActivities }),
  setDraftTextLocal: (target, text) => {
    const key = draftKeyForTarget(target);
    let version = 0;
    set((state) => {
      version = (state.draftEditVersions[key] ?? 0) + 1;
      const draftTexts = { ...state.draftTexts };
      if (text) draftTexts[key] = text;
      else delete draftTexts[key];
      return {
        draftTexts,
        draftTargets: { ...state.draftTargets, [key]: target },
        draftEditVersions: { ...state.draftEditVersions, [key]: version },
      };
    });
    return version;
  },
  mergeHydratedDrafts: (canonicalCwd, drafts, baselineVersions) =>
    set((state) => {
      if (state.workspace?.canonicalCwd !== canonicalCwd) return {};
      const draftTexts = { ...state.draftTexts };
      const draftTargets = { ...state.draftTargets };
      for (const record of drafts) {
        const target = draftTargetFromRecord(record);
        const key = draftKeyForTarget(target);
        if ((state.draftEditVersions[key] ?? 0) !== (baselineVersions[key] ?? 0)) continue;
        draftTexts[key] = record.text;
        draftTargets[key] = target;
      }
      return {
        draftTexts,
        draftTargets,
        draftHydratedWorkspace: canonicalCwd,
      };
    }),
  clearDraftWorkspace: (canonicalCwd) =>
    set((state) => {
      const draftTexts = { ...state.draftTexts };
      const draftTargets = { ...state.draftTargets };
      const draftEditVersions = { ...state.draftEditVersions };
      for (const [key, target] of Object.entries(state.draftTargets)) {
        if (target.canonicalCwd !== canonicalCwd) continue;
        delete draftTexts[key];
        delete draftTargets[key];
        delete draftEditVersions[key];
      }
      return {
        draftTexts,
        draftTargets,
        draftEditVersions,
        draftHydratedWorkspace:
          state.draftHydratedWorkspace === canonicalCwd ? null : state.draftHydratedWorkspace,
      };
    }),
  setAppUpdatePhase: (appUpdatePhase) => set({ appUpdatePhase }),
  pushNotification: (message, level = "info") =>
    set((s) => {
      const item: AppNotification = {
        id: crypto.randomUUID(),
        message,
        level,
        createdAt: Date.now(),
        read: false,
        seq: ++nextNotificationSeq,
      };
      // Only error/warning notifications are "persistent" — they are retained in
      // the notification center history. Info/success notifications are transient
      // (toast only) and never enter the history array.
      const persistent = level === "error" || level === "warning";
      return persistent
        ? { notifications: [...s.notifications.slice(-49), item] }
        : {
            transientNotifications: [
              ...s.transientNotifications.slice(-TRANSIENT_NOTIFICATION_CAP),
              item,
            ],
          };
    }),
  markNotificationsRead: () =>
    set((state) =>
      state.notifications.some((notification) => !notification.read)
        ? {
            notifications: state.notifications.map((notification) =>
              notification.read ? notification : { ...notification, read: true },
            ),
          }
        : state,
    ),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    })),
  clearNotifications: () => set({ notifications: [], transientNotifications: [] }),
  setHostFatal: (hostFatal) => set({ hostFatal }),
  settleHostFailure: (message) =>
    set({
      hostFatal: message,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      desyncReason: undefined,
    }),
  setConnecting: (connecting) => set({ connecting }),
  setRehydrating: (rehydrating) => set({ rehydrating }),
  workspaceSwitchTarget: null,
  setWorkspaceSwitchTarget: (workspaceSwitchTarget) => set({ workspaceSwitchTarget }),

  markDesynchronized: (reason) => {
    const next = epochMarkDesync(epochSlice(get()), reason);
    set({ ...next });
  },

  noteSequence: (sequence) => {
    const r = epochNoteSequence(epochSlice(get()), sequence);
    set({ ...r.state });
    return r.action;
  },

  completeRehydrate: (snap) => {
    const current = get();
    const workspace = snap.workspace !== undefined ? snap.workspace : current.workspace;
    // A rehydrate snapshot is captured by the Host before the desktop knows
    // whether its just-sent optimistic row reached the SDK. Keep unclaimed
    // local rows so the rehydrate boundary never swallows a visible send.
    const session =
      snap.session !== undefined
        ? mergeOptimisticMessages(current.session, snap.session ?? null)
        : current.session;
    // A recovery that anchored a new Host epoch invalidates the previous
    // epoch's catalog/runtime records: merging would resurrect sessions that
    // no longer exist on the new Host (replaceSessionCatalog optimistically
    // retains "running" rows). Rebuild from the fresh snapshot instead.
    const bookkeepingStale = current.epochBookkeepingStale;
    const catalogBase = bookkeepingStale ? emptySessionCatalog() : current.sessionCatalog;
    const sessionCatalog =
      workspace && session
        ? upsertCatalogSnapshot(catalogBase, workspace.id, session)
        : catalogBase;
    set({
      host: snap.host !== undefined ? snap.host : current.host,
      workspace,
      session,
      packages: snap.packages !== undefined ? snap.packages : current.packages,
      tools:
        snap.tools !== undefined
          ? snap.tools
          : snap.session !== undefined
            ? (snap.session?.tools ?? null)
            : current.tools,
      // The rehydrate Host snapshot is authoritative for bindings too; an
      // undefined boundWorkspaces (older Host) keeps the current map.
      ...(snap.host !== undefined ? { boundWorkspaces: boundWorkspacesFromStatus(snap.host) } : {}),
      sessionCatalog,
      ...(bookkeepingStale
        ? { sessionRuntimeStates: {}, epochBookkeepingStale: false }
        : { sessionRuntimeStates: current.sessionRuntimeStates }),
      // Reset desync and advance sequence watermark so post-rehydrate events apply.
      lastSequence:
        snap.lastSequence !== undefined ? snap.lastSequence : Math.max(current.lastSequence, 0),
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      collapsedExtensionWidgetKeys: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(current),
      packageProgress: null,
      packageRetry: null,
      subagentsStatus: EMPTY_SUBAGENTS_STATUS,
    });
  },

  clearHostEpoch: (reason) => {
    set({
      ...emptyEpoch(),
      epochBookkeepingStale: false,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      collapsedExtensionWidgetKeys: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      sessionRuntimeStates: {},
      boundWorkspaces: {},
      hostFatal: reason,
      rehydrating: false,
    });
  },
}));
