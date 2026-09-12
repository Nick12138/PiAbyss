import type { MessageKey } from "../i18n";
import type { AppState } from "../stores/app-store";
import { useAppStore } from "../stores/app-store";
import { requestTreeOverlay } from "../tree-overlay";
import { abortCurrentAgent, createNewSession, isCreateSessionPending } from "./actions";
import {
  requestDockCommand,
  requestGlobalSearchOpen,
  requestShortcutHelp,
  requestSidebarToggle,
} from "./events";

export type AppCommand = {
  id: string;
  titleKey: MessageKey;
  titleParams?: Record<string, string | number>;
  chord?: string;
  worksInTerminal?: boolean;
  textInputSelector?: string;
  blockedByOverlay?: boolean;
  enabled?: (state: AppState) => boolean;
  run: () => void | Promise<unknown>;
};

const dockTabCommands: AppCommand[] = Array.from({ length: 9 }, (_, index) => ({
  id: `dock.activate.${index + 1}`,
  titleKey: "commandActivateDockTab",
  titleParams: { index: index + 1 },
  chord: `mod+${index + 1}`,
  run: () => requestDockCommand({ kind: "activate-visible", index }),
}));

export const appCommands: readonly AppCommand[] = [
  {
    id: "session.new",
    titleKey: "commandNewSession",
    chord: "mod+n",
    worksInTerminal: true,
    enabled: (state) =>
      Boolean(state.host && state.workspace?.servicesReady) && !isCreateSessionPending(),
    run: createNewSession,
  },
  {
    id: "app.openSettings",
    titleKey: "commandOpenSettings",
    chord: "mod+,",
    worksInTerminal: true,
    enabled: (state) => state.page === "chat" || !state.providersDirty,
    run: () => useAppStore.getState().openSettingsSection("general"),
  },
  {
    id: "sidebar.toggle",
    titleKey: "commandToggleSidebar",
    chord: "mod+b",
    worksInTerminal: true,
    run: requestSidebarToggle,
  },
  {
    id: "dock.toggle",
    titleKey: "commandToggleDock",
    chord: "mod+j",
    worksInTerminal: true,
    run: () => requestDockCommand({ kind: "toggle" }),
  },
  {
    id: "chat.tree",
    titleKey: "commandOpenTree",
    chord: "mod+t",
    run: requestTreeOverlay,
  },
  {
    id: "sessions.globalSearch",
    titleKey: "commandGlobalSearch",
    chord: "mod+f",
    worksInTerminal: true,
    enabled: (state) => Boolean(state.host),
    run: requestGlobalSearchOpen,
  },
  ...dockTabCommands,
  {
    id: "chat.stop",
    titleKey: "commandStopGeneration",
    chord: "escape",
    textInputSelector: ".chat-composer-input",
    blockedByOverlay: true,
    enabled: (state) => state.page === "chat" && state.session?.isIdle === false,
    run: abortCurrentAgent,
  },
  {
    id: "app.shortcuts",
    titleKey: "commandShowShortcuts",
    chord: "mod+/",
    worksInTerminal: true,
    run: requestShortcutHelp,
  },
];
