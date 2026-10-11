import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostClient } from "./host-client";
import {
  createTauriTransport,
  rebindActiveWorkspaceHost,
  refreshActiveRoute,
  replayActiveHostReady,
} from "./tauri-transport";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

describe("createTauriTransport", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset();
    mocks.listen.mockReset();
  });

  it("provides a protocol-valid browser hello response", async () => {
    mocks.isTauri.mockReturnValue(false);
    const client = new HostClient();
    client.attach(await createTauriTransport());

    await expect(client.hello()).resolves.toMatchObject({
      hostInstanceId: "00000000-0000-4000-8000-000000000004",
      nodeVersion: "browser",
    });
    expect(mocks.listen).not.toHaveBeenCalled();

    client.detach();
  });

  it("propagates native listener initialization failures", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.listen.mockRejectedValueOnce(new Error("event listener unavailable"));

    await expect(createTauriTransport()).rejects.toThrow("event listener unavailable");
  });

  it("routes frames only from the active workspace Host", async () => {
    mocks.isTauri.mockReturnValue(true);
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    mocks.listen.mockImplementation(
      async (name: string, handler: (event: { payload: unknown }) => void) => {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
    );
    let activeRoute = "route-a";
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === "pi_host_active_route") return activeRoute;
      return undefined;
    });

    const transport = await createTauriTransport();
    const lines: string[] = [];
    transport.onMessage((line) => lines.push(line));
    const stdout = listeners.get("pi-host-stdout")!;

    stdout({ payload: { routeId: "route-b", line: "ignored" } });
    stdout({ payload: { routeId: "route-a", line: "from-a" } });
    // The memo widget window refreshes its route before each request batch;
    // a route refresh must re-point the frame filter.
    activeRoute = "route-b";
    await refreshActiveRoute();
    stdout({ payload: { routeId: "route-a", line: "ignored-after-switch" } });
    stdout({ payload: { routeId: "route-b", line: "from-b" } });
    await expect(replayActiveHostReady()).resolves.toBe(true);

    expect(lines).toEqual(["from-a", "from-b"]);
    expect(mocks.invoke).toHaveBeenCalledWith("pi_host_replay_ready", { routeId: "route-b" });
    transport.dispose?.();
  });

  it("commits the switched workspace on the active route", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(undefined);

    await expect(rebindActiveWorkspaceHost("C:/workspace-b")).resolves.toBe(true);

    expect(mocks.invoke).toHaveBeenCalledWith("pi_host_rebind_active", {
      cwd: "C:/workspace-b",
    });
  });

  it("treats a replay miss during cold start as a no-op, not a failure", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error("Host has not announced ready yet"));

    await expect(replayActiveHostReady()).resolves.toBe(false);
  });
});
