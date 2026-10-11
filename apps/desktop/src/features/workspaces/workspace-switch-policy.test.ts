import { describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { waitForWorkspaceServicesReady } from "./workspace-switch-policy";

describe("workspace switch policy", () => {
  it("resolves once the active workspace's service graph is ready", async () => {
    useAppStore.getState().setHostFatal(null);
    useAppStore.getState().setWorkspace(null);
    const pending = waitForWorkspaceServicesReady();
    useAppStore.getState().setWorkspace({
      id: "workspace-a",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 1,
      servicesReady: false,
    });
    useAppStore.getState().setWorkspace({
      id: "workspace-a",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 2,
      servicesReady: true,
    });
    await expect(pending).resolves.toBe(true);
  });

  it("resolves false on a host-fatal error", async () => {
    useAppStore.getState().setHostFatal(null);
    useAppStore.getState().setWorkspace(null);
    const pending = waitForWorkspaceServicesReady();
    useAppStore.getState().setHostFatal("host down");
    await expect(pending).resolves.toBe(false);
    useAppStore.getState().setHostFatal(null);
  });

  it("is already settled when the graph is ready before the wait starts", async () => {
    useAppStore.getState().setHostFatal(null);
    useAppStore.getState().setWorkspace({
      id: "workspace-a",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 1,
      servicesReady: true,
    });
    await expect(waitForWorkspaceServicesReady()).resolves.toBe(true);
  });
});
