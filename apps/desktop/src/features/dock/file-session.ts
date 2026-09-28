import { create } from "zustand";
import type { WorkspaceFilePreview, WorkspaceTextFile } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { tCurrent } from "../../lib/i18n/use-t";

/**
 * The dock hosts more than one open file: the Files tab keeps its browsing
 * session under {@link FILES_SESSION_KEY}, and every file the user opens in
 * its own tab gets its own session under {@link fileTabSessionKey}. Each key
 * behaves exactly like the old singleton did — same loading, conflict, save
 * and unsaved-changes semantics — while the window-level guards
 * (`ensureFileCanLeave`, `fileWorkspaceForRecovery`) aggregate over all keys.
 */
export const FILES_SESSION_KEY = "files";

/** Session key owned by the dock tab that shows a single file. */
export function fileTabSessionKey(path: string): `file:${string}` {
  return `file:${path}`;
}

/** One open file the dock is tracking, regardless of tab. */
export type FileSession = {
  root: string | null;
  path: string | null;
  file: WorkspaceFilePreview | null;
  text: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: WorkspaceTextFile | null;
  revision: number;
  mixedConfirmed: boolean;
  leavePrompt: boolean;
};

const EMPTY_SESSION: FileSession = {
  root: null,
  path: null,
  file: null,
  text: "",
  loading: false,
  saving: false,
  error: null,
  conflict: null,
  revision: 0,
  mixedConfirmed: false,
  leavePrompt: false,
};

type FileSessionStore = {
  sessions: Record<string, FileSession>;
};

const useFileSessionStore = create<FileSessionStore>(() => ({ sessions: {} }));

/** A pending "unsaved changes" confirmation, shared by every dirty session. */
let leavePromise: Promise<boolean> | null = null;
let resolveLeave: ((answer: boolean) => void) | null = null;

function readSession(key: string): FileSession {
  return useFileSessionStore.getState().sessions[key] ?? EMPTY_SESSION;
}

function patchSession(key: string, patch: Partial<FileSession>): void {
  const sessions = useFileSessionStore.getState().sessions;
  useFileSessionStore.setState({
    sessions: { ...sessions, [key]: { ...(sessions[key] ?? EMPTY_SESSION), ...patch } },
  });
}

function sessionKeys(): string[] {
  return Object.keys(useFileSessionStore.getState().sessions);
}

/**
 * Subscribes to one file session. The `getState`/`setState` companions keep
 * the flat per-session shape callers had before the dock grew tabs; they
 * default to the Files tab session.
 */
export const useFileSession = Object.assign(
  (key: string = FILES_SESSION_KEY): FileSession =>
    useFileSessionStore((state) => state.sessions[key] ?? EMPTY_SESSION),
  {
    getState: (key: string = FILES_SESSION_KEY): FileSession => readSession(key),
    setState: (patch: Partial<FileSession>, key: string = FILES_SESSION_KEY): void =>
      patchSession(key, patch),
  },
);

/** Which session the shared unsaved-changes dialog should speak for. */
export function useFileLeavePrompt(): {
  leavePrompt: boolean;
  path: string | null;
  saving: boolean;
} {
  const sessions = useFileSessionStore((state) => state.sessions);
  for (const session of Object.values(sessions)) {
    if (session.leavePrompt) {
      return { leavePrompt: true, path: session.path, saving: session.saving };
    }
  }
  return { leavePrompt: false, path: null, saving: false };
}

export const fileIsDirty = (session: FileSession = readSession(FILES_SESSION_KEY)) =>
  session.file?.kind === "text" && session.text !== session.file.text;

/** Whether any dock file session (Files tab or a file tab) holds unsaved work. */
export function anyFileSessionBusy(): boolean {
  return busyKeys().length > 0;
}

function isBusy(session: FileSession): boolean {
  return fileIsDirty(session) || session.saving;
}

function busyKeys(): string[] {
  return sessionKeys().filter((key) => isBusy(readSession(key)));
}

/** Leaves the edited workspace in place across a host restart. */
export function fileWorkspaceForRecovery(fallback: string | undefined) {
  for (const key of sessionKeys()) {
    const session = readSession(key);
    if (isBusy(session)) return session.root ?? fallback;
  }
  return fallback;
}

export async function ensureFileCanChangeWorkspace(cwd: string): Promise<boolean> {
  const blocked = sessionKeys().some((key) => {
    const session = readSession(key);
    return session.root !== null && session.root !== cwd;
  });
  if (!blocked) return true;
  return ensureFileCanLeave();
}

export async function ensureFileCanLeave(): Promise<boolean> {
  if (busyKeys().length === 0) return true;
  if (leavePromise) return leavePromise;
  for (const key of busyKeys()) patchSession(key, { leavePrompt: true });
  leavePromise = new Promise<boolean>((resolve) => {
    resolveLeave = resolve;
  });
  return leavePromise;
}

/** Replacing a session's file only needs that session to be clean. */
async function ensureSessionCanLeave(key: string): Promise<boolean> {
  if (!isBusy(readSession(key))) return true;
  return ensureFileCanLeave();
}

function clearLeavePrompts() {
  for (const key of sessionKeys()) {
    if (readSession(key).leavePrompt) patchSession(key, { leavePrompt: false });
  }
}

export async function answerFileLeave(answer: "save" | "discard" | "cancel") {
  if (sessionKeys().some((key) => readSession(key).saving)) return;
  if (answer === "save" && !(await saveAllOpenFiles())) {
    clearLeavePrompts();
    resolveLeave?.(false);
  } else {
    if (answer === "discard") {
      for (const key of sessionKeys()) {
        const session = readSession(key);
        patchSession(key, {
          text: session.file?.kind === "text" ? session.file.text : "",
          conflict: null,
          revision: session.revision + 1,
        });
      }
    }
    clearLeavePrompts();
    resolveLeave?.(answer !== "cancel");
  }
  resolveLeave = null;
  leavePromise = null;
}

async function saveAllOpenFiles(): Promise<boolean> {
  let saved = true;
  for (const key of busyKeys()) {
    saved = (await saveOpenFile(undefined, key)) && saved;
  }
  return saved;
}

/** Races are scoped per session so two tabs never cancel each other's read. */
const generations = new Map<string, number>();

function beginRequest(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

function isCurrentRequest(key: string, request: number): boolean {
  return generations.get(key) === request;
}

function invalidate(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

function contextFor(root: string | null) {
  const { host, workspace, connecting, rehydrating } = useAppStore.getState();
  if (!host || !workspace || connecting || rehydrating || workspace.canonicalCwd !== root)
    throw new Error(tCurrent("fileDisconnected"));
  return { host, workspace, context: workspaceContext(host, workspace) };
}

function isCurrent(context: ReturnType<typeof contextFor>) {
  const current = useAppStore.getState();
  return (
    current.host?.hostInstanceId === context.host.hostInstanceId &&
    current.workspace?.id === context.workspace.id &&
    current.workspace?.revision === context.workspace.revision
  );
}

/**
 * Loads a workspace file into `key`'s session. A caller that already read the
 * preview (the dock's file-chip router, which has to probe the file type to
 * decide between the system app and a dock tab) can hand it over through
 * `preloaded` and save the second read.
 */
export async function openWorkspaceFile(
  path: string,
  key: string = FILES_SESSION_KEY,
  preloaded?: WorkspaceFilePreview,
): Promise<boolean> {
  const root = useAppStore.getState().workspace?.canonicalCwd;
  if (!root) return false;
  const old = readSession(key);
  if (old.root === root && old.path === path && old.file) return true;
  if (!(await ensureSessionCanLeave(key))) return false;
  const request = beginRequest(key);
  patchSession(key, {
    root,
    path,
    file: null,
    text: "",
    loading: true,
    error: null,
    conflict: null,
    mixedConfirmed: false,
    revision: old.revision + 1,
  });
  try {
    const file =
      preloaded && preloaded.path === path
        ? preloaded
        : await (async () => {
            const ctx = contextFor(root);
            const response = await hostClient.request("workspace.readFilePreview", ctx.context, {
              path,
            });
            if (!isCurrentRequest(key, request) || !isCurrent(ctx)) return null;
            if (!response.ok) throw new Error(response.error.message);
            return response.result;
          })();
    if (!file) return false;
    if (!isCurrentRequest(key, request)) return false;
    patchSession(key, { file, text: file.kind === "text" ? file.text : "" });
    return true;
  } catch (error) {
    if (isCurrentRequest(key, request))
      patchSession(key, { error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    if (isCurrentRequest(key, request)) patchSession(key, { loading: false });
  }
}

export async function refreshOpenFile(key: string = FILES_SESSION_KEY) {
  const before = readSession(key);
  if (!before.path || before.saving || before.loading) return;
  const request = beginRequest(key);
  try {
    const ctx = contextFor(before.root);
    const response = await hostClient.request("workspace.readFilePreview", ctx.context, {
      path: before.path,
    });
    if (!isCurrentRequest(key, request) || !isCurrent(ctx)) return;
    if (!response.ok) throw new Error(response.error.message);
    const current = readSession(key);
    if (current.saving) return;
    const file = response.result;
    if (fileIsDirty(current)) {
      if (file.kind !== "text") {
        patchSession(key, { error: tCurrent("fileChangedType") });
      } else {
        patchSession(key, {
          conflict:
            current.file?.kind === "text" && file.version !== current.file.version ? file : null,
          error: null,
        });
      }
    } else if (
      file.kind === "text" &&
      current.file?.kind === "text" &&
      file.version === current.file.version
    ) {
      patchSession(key, { error: null, conflict: null });
    } else {
      patchSession(key, {
        file,
        text: file.kind === "text" ? file.text : "",
        conflict: null,
        error: null,
        mixedConfirmed: false,
        revision: current.revision + 1,
      });
    }
  } catch (error) {
    if (isCurrentRequest(key, request))
      patchSession(key, { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function saveOpenFile(
  overrideVersion?: string,
  key: string = FILES_SESSION_KEY,
): Promise<boolean> {
  const start = readSession(key);
  if (start.file?.kind !== "text" || !start.path || start.saving) return false;
  if (!fileIsDirty(start)) return true;
  if (start.conflict && !overrideVersion) return false;
  beginRequest(key);
  patchSession(key, { saving: true, error: null });
  try {
    const ctx = contextFor(start.root);
    const response = await hostClient.request("workspace.writeTextFile", ctx.context, {
      path: start.path,
      text: start.text,
      expectedVersion: overrideVersion ?? start.file.version,
    });
    if (!isCurrent(ctx)) throw new Error(tCurrent("fileDisconnected"));
    if (!response.ok) {
      if (response.error.code === "FILE_CONFLICT") {
        patchSession(key, { saving: false });
        await refreshOpenFile(key);
        return false;
      }
      throw new Error(response.error.message);
    }
    patchSession(key, { file: response.result, conflict: null, mixedConfirmed: true });
    return !fileIsDirty(readSession(key));
  } catch (error) {
    patchSession(key, { error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    patchSession(key, { saving: false });
  }
}

export function reloadConflict(key: string = FILES_SESSION_KEY) {
  const state = readSession(key);
  if (!state.conflict) return;
  patchSession(key, {
    file: state.conflict,
    text: state.conflict.text,
    conflict: null,
    error: null,
    mixedConfirmed: false,
    revision: state.revision + 1,
  });
}

/** Drops one session, or every session when `key` is omitted. */
export function clearFileSession(key?: string) {
  if (key === undefined) {
    for (const existing of sessionKeys()) invalidate(existing);
    useFileSessionStore.setState({ sessions: {} });
    return;
  }
  invalidate(key);
  const sessions = useFileSessionStore.getState().sessions;
  if (!(key in sessions)) return;
  const next = { ...sessions };
  delete next[key];
  useFileSessionStore.setState({ sessions: next });
}
