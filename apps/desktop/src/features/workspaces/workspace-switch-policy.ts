import { useAppStore, type AppState } from "../../lib/stores/app-store";

type WorkspaceRuntimeState = Pick<AppState, "session" | "sessionCatalog">;
type WorkspaceActivationState = Pick<
  AppState,
  "host" | "workspace" | "session" | "connecting" | "rehydrating" | "desynchronized" | "hostFatal"
>;

const WORKSPACE_ACTIVATION_TIMEOUT_MS = 180_000;

export function workspaceHasActiveAgent(state: WorkspaceRuntimeState): boolean {
  if (state.session && !state.session.isIdle) return true;
  return Object.values(state.sessionCatalog.entries).some(
    (entry) =>
      entry.runtimeState === "starting" ||
      entry.runtimeState === "running" ||
      entry.runtimeState === "queued",
  );
}

export function isWorkspaceSwitchBusyError(error: { code?: string }): boolean {
  return error.code === "AGENT_BUSY" || error.code === "SERVICE_GRAPH_BUSY";
}

export function workspaceActivationReady(
  state: WorkspaceActivationState,
  previousHostId: string,
): boolean {
  if (
    state.connecting ||
    state.rehydrating ||
    state.desynchronized ||
    state.hostFatal ||
    !state.host ||
    !state.workspace?.servicesReady ||
    state.host.hostInstanceId === previousHostId ||
    state.host.workspaceId !== state.workspace.id ||
    state.host.workspaceRevision !== state.workspace.revision
  ) {
    return false;
  }
  return (
    state.host.sessionId === null ||
    (state.session?.sessionId === state.host.sessionId &&
      state.session.revision === state.host.sessionRevision)
  );
}

export function waitForWorkspaceActivation(previousHostId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const inspect = (state: WorkspaceActivationState) => {
      if (state.hostFatal) {
        finish(new Error(state.hostFatal));
      } else if (workspaceActivationReady(state, previousHostId)) {
        finish();
      }
    };
    const timeout = globalThis.setTimeout(
      () => finish(new Error("Workspace Host activation timed out")),
      WORKSPACE_ACTIVATION_TIMEOUT_MS,
    );
    unsubscribe = useAppStore.subscribe(inspect);
    inspect(useAppStore.getState());
  });
}

/** How long callers may wait for the active workspace's service graph to be ready. */
const WORKSPACE_SERVICES_READY_TIMEOUT_MS = 60_000;

type WorkspaceServicesReadyState = Pick<AppState, "hostFatal" | "workspace">;

/**
 * Resolves true once the active workspace's service graph is built
 * (`workspace.servicesReady`); false on host-fatal or timeout.
 *
 * A just-committed optimistic switch hands the renderer a pending shell
 * before the background graph build settles, so mutations like session.create
 * fail silently right after the switch. Callers that immediately mutate the
 * graph wait here first.
 */
export function waitForWorkspaceServicesReady(): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      resolve(value);
    };
    const inspect = (state: WorkspaceServicesReadyState) => {
      if (state.hostFatal) finish(false);
      else if (state.workspace?.servicesReady) finish(true);
    };
    const timeout = globalThis.setTimeout(() => finish(false), WORKSPACE_SERVICES_READY_TIMEOUT_MS);
    unsubscribe = useAppStore.subscribe(inspect);
    inspect(useAppStore.getState());
  });
}
