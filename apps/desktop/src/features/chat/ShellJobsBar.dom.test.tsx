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

const STALE_JOB = {
  ...FINISHED_JOB,
  id: "job_stale1",
  finishedAt: Date.now() - 120_000,
};

// Same id as RUNNING_JOB — a running job that has just transitioned to failed.
const FAILED_JOB = {
  ...RUNNING_JOB,
  status: "failed" as const,
  finishedAt: Date.now() - 500,
};

/** Mocks shelljobs.* requests with the given job snapshot + output tail. */
function mockShellJobRequests(
  jobs: unknown[],
  output: { lines: string[]; truncated?: boolean } = { lines: [] },
) {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
    if (method === "shelljobs.list") {
      return envelope(method, { jobs }) as never;
    }
    if (method === "shelljobs.output") {
      return envelope(method, {
        lines: output.lines,
        truncated: output.truncated ?? false,
      }) as never;
    }
    if (method === "shelljobs.stop") {
      return envelope(method, { stopped: true }) as never;
    }
    return envelope(method, { accepted: true }) as never;
  });
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("shell-jobs-toggle"));
}

describe("ShellJobsBar", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session(SESSION_ID));
    useAppStore.getState().setShellJobs([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    cleanup();
  });

  it("renders nothing without running or recently finished jobs", () => {
    mockShellJobRequests([]);
    useAppStore.getState().setShellJobs([STALE_JOB] as never);
    const { container } = render(<ShellJobsBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("collapses into a summary row and hydrates via shelljobs.list", async () => {
    const request = mockShellJobRequests([RUNNING_JOB, FINISHED_JOB]);
    render(<ShellJobsBar />);

    await waitFor(() =>
      expect(useAppStore.getState().shellJobs.map((job) => job.id)).toEqual([
        "job_run1",
        "job_done1",
      ]),
    );
    // Collapsed: a compact pill (not the full-width bar) with the running
    // count in its accessible name and the first command as a preview.
    const pill = screen.getByTestId("shell-jobs-toggle");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveAttribute("aria-label", "Background jobs (1)");
    expect(pill).toHaveClass("rounded-full");
    expect(screen.getByText("npm run dev")).toBeInTheDocument();
    // No per-job rows (or the finished job) before expanding.
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByText("job_done1")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "shelljobs.list",
      { expectedHostInstanceId: HOST_ID },
      null,
    );
  });

  it("opens a floating popover with job rows and recently finished jobs", async () => {
    const user = userEvent.setup();
    mockShellJobRequests([RUNNING_JOB, FINISHED_JOB]);
    useAppStore.getState().setShellJobs([RUNNING_JOB, FINISHED_JOB] as never);
    render(<ShellJobsBar />);

    await expand(user);
    expect(screen.getByTestId("shell-jobs-toggle")).toHaveAttribute("aria-expanded", "true");
    // The job list lives in a portal popover, not the composer column.
    const panel = screen.getByTestId("shell-jobs-panel");
    expect(panel.ownerDocument.body).toContain(panel);
    // Running job gets a stop control; the finished one stays visible without it.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("30s")).toBeInTheDocument();
  });

  it("closes the popover on outside click, Escape, and pill toggle", async () => {
    const user = userEvent.setup();
    mockShellJobRequests([RUNNING_JOB]);
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    render(<ShellJobsBar />);

    await expand(user);
    expect(screen.getByTestId("shell-jobs-panel")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("shell-jobs-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell-jobs-toggle")).toHaveAttribute("aria-expanded", "false");

    await expand(user);
    // Clicking anywhere outside (pill and panel) closes the popover.
    await user.click(document.body);
    expect(screen.queryByTestId("shell-jobs-panel")).not.toBeInTheDocument();

    await expand(user);
    await user.click(screen.getByTestId("shell-jobs-toggle"));
    expect(screen.queryByTestId("shell-jobs-panel")).not.toBeInTheDocument();
  });

  it("groups other sessions under a separate section with a cwd badge", async () => {
    const user = userEvent.setup();
    const otherJob = {
      ...RUNNING_JOB,
      id: "job_other",
      cwd: "/other/workspace",
      sessionId: "s-other",
    };
    mockShellJobRequests([RUNNING_JOB, otherJob]);
    useAppStore.getState().setShellJobs([RUNNING_JOB, otherJob] as never);
    render(<ShellJobsBar />);

    await expand(user);
    expect(screen.getByText("Other sessions")).toBeInTheDocument();
    expect(screen.getByText("workspace")).toBeInTheDocument();
  });

  it("clicking a job opens the session that submitted it", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    mockShellJobRequests([RUNNING_JOB]);
    const navigate = vi
      .spyOn(sessionNavigation, "openSessionAcrossWorkspaces")
      .mockResolvedValue({ status: "opened" });
    render(<ShellJobsBar />);

    await expand(user);
    // The header also shows the command text, so target the row via its title.
    await user.click(screen.getByTitle("Open the session that started this job (/repo)"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        { cwd: "/repo", sessionId: SESSION_ID },
        expect.objectContaining({ resolveSessionPath: expect.any(Function) }),
      ),
    );
  });

  it("stops with a two-click confirm without sending a duplicate Agent notification", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    const request = mockShellJobRequests([RUNNING_JOB]);
    render(<ShellJobsBar />);

    await expand(user);
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
    expect(request).not.toHaveBeenCalledWith("agent.prompt", expect.anything(), expect.anything());
    expect(request).not.toHaveBeenCalledWith(
      "agent.followUp",
      expect.anything(),
      expect.anything(),
    );
  });

  it("toggles a live output tail that hydrates from shelljobs.output", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    const request = mockShellJobRequests([RUNNING_JOB], {
      lines: ["vite ready", "listening on 5173"],
    });
    render(<ShellJobsBar />);

    await expand(user);
    await user.click(screen.getByRole("button", { name: "Output" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "shelljobs.output",
        { expectedHostInstanceId: HOST_ID },
        { jobId: "job_run1", limit: 200 },
      ),
    );
    expect(await screen.findByText("vite ready")).toBeInTheDocument();
    expect(screen.getByText("listening on 5173")).toBeInTheDocument();
  });

  it("raises an error notification when a seen-running job fails", async () => {
    useAppStore.getState().setShellJobs([RUNNING_JOB] as never);
    mockShellJobRequests([FAILED_JOB]);
    render(<ShellJobsBar />);

    // Simulate the watcher pushing the failed snapshot.
    useAppStore.getState().setShellJobs([FAILED_JOB] as never);
    await waitFor(() => {
      const notifications = useAppStore.getState().notifications;
      expect(notifications.some((item) => item.message.includes("npm run dev"))).toBe(true);
      expect(notifications.some((item) => item.level === "error")).toBe(true);
    });
  });
});
