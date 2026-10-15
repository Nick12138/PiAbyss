import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailureResponse, createHostError } from "@piabyss/protocol";
import { logger } from "./logger.js";
import { PiHostServer } from "./server.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function server(): PiHostServer {
  const instance = new PiHostServer({
    agentDir: "C:/agent",
    sdkVersion: "0.84.2",
    getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
    capabilities: { packageUpdateCheck: false, extensionUi: true, sessionExport: false },
    handlers: {},
  });
  instance.identity.workspaceId = WORKSPACE_ID;
  instance.identity.workspaceRevision = 4;
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Host refusal logging", () => {
  /**
   * The renderer collapses these codes into a one-line toast that names neither
   * the method nor the reason, so the log line is the only way to tell which
   * request lost a race after the toast has disappeared.
   */
  it("records the method and reason of a rejection the UI cannot self-heal", async () => {
    const host = server();
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    host.writeResponse(
      createFailureResponse(
        host.identity.snapshot(),
        "req-1",
        "session.open",
        createHostError("AGENT_NOT_READY", "Workspace services not ready"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith(
      "Host refused request",
      expect.objectContaining({
        method: "session.open",
        code: "AGENT_NOT_READY",
        reason: "Workspace services not ready",
      }),
    );
  });

  it("keeps silent busy retries out of the log", async () => {
    const host = server();
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    host.writeResponse(
      createFailureResponse(
        host.identity.snapshot(),
        "req-2",
        "workspace.setCurrent",
        createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", { retryable: true }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).not.toHaveBeenCalled();
  });
});
