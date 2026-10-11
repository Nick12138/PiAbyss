import { useAppStore, type AppState } from "../../lib/stores/app-store";

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
