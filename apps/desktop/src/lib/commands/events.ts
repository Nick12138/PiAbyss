export type DockCommandRequest = { kind: "toggle" } | { kind: "activate-visible"; index: number };

type VoidHandler = () => void;
type DockHandler = (request: DockCommandRequest) => void;

let sidebarToggleHandler: VoidHandler | null = null;
let dockHandler: DockHandler | null = null;
let shortcutHelpHandler: VoidHandler | null = null;
let globalSearchHandler: VoidHandler | null = null;

function subscribe<T>(setHandler: (handler: T | null) => void, handler: T): () => void {
  setHandler(handler);
  return () => setHandler(null);
}

export function subscribeSidebarToggle(handler: VoidHandler): () => void {
  return subscribe((next) => {
    sidebarToggleHandler = next;
  }, handler);
}

export function requestSidebarToggle(): void {
  sidebarToggleHandler?.();
}

export function subscribeDockCommands(handler: DockHandler): () => void {
  return subscribe((next) => {
    dockHandler = next;
  }, handler);
}

export function requestDockCommand(request: DockCommandRequest): void {
  dockHandler?.(request);
}

export function subscribeShortcutHelp(handler: VoidHandler): () => void {
  return subscribe((next) => {
    shortcutHelpHandler = next;
  }, handler);
}

export function requestShortcutHelp(): void {
  shortcutHelpHandler?.();
}

export function subscribeGlobalSearchOpen(handler: VoidHandler): () => void {
  return subscribe((next) => {
    globalSearchHandler = next;
  }, handler);
}

export function requestGlobalSearchOpen(): void {
  globalSearchHandler?.();
}
