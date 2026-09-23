/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import * as sessionNavigation from "../../lib/bridge/session-navigation";
import { useAppStore } from "../../lib/stores/app-store";
import { ShellJobsBar } from "./ShellJobsBar";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "agentBusy",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/repo",
    canonicalCwd: "/repo",
    revision: 1,
    servicesReady: true,
  };
}

function session(sessionId: string): SessionSnapshot {
  return {
    sessionId,
    cwd: "/repo",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 7, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "shelljob-test",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

const RUNNING_JOB = {
  id: "job_run1",
  command: "npm run dev",
  cwd: "/repo",
  sessionId: SESSION_ID,
  createdAt: Date.now() - 60_000,
  status: "running" as const,
  pid: 99,
  startedAt: Date.now() - 30_000,
};

const FINISHED_JOB = {
  ...RUNNING_JOB,
  id: "job_done1",
  status: "completed" as const,
  finishedAt: Date.now() - 1_000,
};

describe("ShellJobsBar", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session(SESSION_ID));
    useAppStore.getState().setShellJobs([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing without running jobs", () => {
    useAppStore.getState().setShellJobs([FINISHED_JOB] as never);
    const { container } = render(<ShellJobsBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only running jobs and hydrates via shelljobs.list", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(
        envelope("shelljobs.list", { jobs: [RUNNING_JOB, FINISHED_JOB] }) as never,
      );
    render(<ShellJobsBar />);

    await waitFor(() =>
      expect(useAppStore.getState().shellJobs.map((job) => job.id)).toEqual([
        "job_run1",
        "job_done1",
      ]),
    );
    expect(screen.getByText("npm run dev")).toBeInTheDocument();
    expect(screen.queryByText("job_done1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "shelljobs.list",
      { expectedHostInstanceId: HOST_ID },
      null,
    );
  });

  it("clicking a job opens the session that submitted it", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("shelljobs.list", { jobs: [RUNNING_JOB] }) as never,
    );
    const navigate = vi
      .spyOn(sessionNavigation, "openSessionAcrossWorkspaces")
      .mockResolvedValue({ status: "opened" });
    render(<ShellJobsBar />);

    await user.click(screen.getByRole("button", { name: /npm run dev/ }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ cwd: "/repo", sessionId: SESSION_ID }),
    );
  });

  it("stops with a two-click confirm and notifies the agent via followUp for the owning session", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "shelljobs.list") {
        return envelope(method, { jobs: [RUNNING_JOB] }) as never;
      }
      if (method === "shelljobs.stop") {
        return envelope(method, { stopped: true }) as never;
      }
      return envelope(method, { accepted: true }) as never;
    });
    render(<ShellJobsBar />);

    const stop = await screen.findByRole("button", { name: "Stop" });
    await user.click(stop);
    // First click only arms the confirm state.
    expect(request).not.toHaveBeenCalledWith(
      "shelljobs.stop",
      expect.anything(),
      expect.anything(),
    );

    const confirm = await screen.findByRole("button", { name: "Confirm stop?" });
    await user.click(confirm);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "shelljobs.stop",
        { expectedHostInstanceId: HOST_ID },
        { jobId: "job_run1" },
      ),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.followUp", expect.anything(), {
        text: expect.stringContaining("job_run1"),
      }),
    );
  });
});
