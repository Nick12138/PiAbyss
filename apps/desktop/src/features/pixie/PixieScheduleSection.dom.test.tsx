/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  ScheduleJob,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { requestComposerInsert } from "../../lib/composer-insert";
import { useAppStore } from "../../lib/stores/app-store";
import { PixieScheduleSection } from "./PixieScheduleSection";

/**
 * 随行面板「周期计划」：默认折叠时一行就是全部信息（活跃数 + 下次触发倒计时），
 * 展开是列表与开关，创建走对话（只把引导语塞进输入框）。
 */
vi.mock("../schedule/schedule-plugin-gate", () => ({
  useSchedulePluginEnabled: () => true,
}));

vi.mock("../../lib/composer-insert", () => ({
  requestComposerInsert: vi.fn(),
}));

const PIXIE_CWD = "/agent/workspace/pixie";
const NEXT_RUN_AT = new Date(Date.now() + 2 * 3_600_000).toISOString();

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "j1",
    name: "每日构建报告",
    prompt: "总结昨天的提交",
    command: null,
    cwd: "/work/okxbot",
    enabled: true,
    permission: "readonly",
    model: null,
    trigger: { type: "interval", every: "1d" },
    missedWindow: "skip",
    timeoutMs: 60_000,
    maxRuns: null,
    loadExtensions: false,
    tags: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    updatedBy: "user",
    nextRunAt: NEXT_RUN_AT,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    runCount: 0,
    terminated: null,
    ...overrides,
  } as ScheduleJob;
}

const JOBS: ScheduleJob[] = [
  job(),
  job({
    id: "j2",
    name: "手动巡检",
    cwd: "/work/PiAbyss",
    enabled: false,
    trigger: { type: "manual" },
    nextRunAt: null,
  }),
];

function section(): HTMLElement {
  return screen.getByTestId("pixie-schedule-section");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "schedule.status") return { ok: true, result: { available: true } } as never;
    if (method === "schedule.listJobs") {
      return { ok: true, result: { jobs: JOBS, activeJobIds: [] } } as never;
    }
    if (method === "schedule.setJobEnabled") {
      const target = JOBS[0];
      return { ok: true, result: { job: { ...target, enabled: true } } } as never;
    }
    return { ok: true, result: null } as never;
  });
  useAppStore.setState({
    host: {
      protocolVersion: 1,
      hostInstanceId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceRevision: 1,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 1,
      sdkVersion: "test",
      nodeVersion: process.version,
      agentDir: "/agent",
      phase: "ready",
      capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    } satisfies HostStatusSnapshot,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      cwd: PIXIE_CWD,
      canonicalCwd: PIXIE_CWD,
      revision: 1,
      servicesReady: true,
    } as WorkspaceSnapshot,
    desktopSettings: { language: "en", knownWorkspaces: [] } as unknown as DesktopSettings,
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  globalThis.localStorage?.clear();
});

describe("PixieScheduleSection", () => {
  it("默认折叠：只占一行，汇总写清活跃数与下次触发倒计时", async () => {
    render(<PixieScheduleSection />);

    expect(section()).toHaveAttribute("data-open", "false");
    const header = screen.getByTestId("pixie-schedule-section-toggle");
    // 折叠态那一行就写清「下次什么时候」：倒计时按现在算，取到「NhNm」即可。
    await waitFor(() => expect(header.textContent).toMatch(/next in \d+h\d+m/));
    // 计数徽章 = 活跃计划数（停用的不算）。
    expect(header).toHaveTextContent("1");
    expect(screen.queryByTestId("pixie-schedule-row")).toBeNull();
  });

  it("展开后是计划列表：名称 / 触发 / 倒计时 / 工作区 / 开关", async () => {
    const user = userEvent.setup();
    render(<PixieScheduleSection />);

    await user.click(screen.getByTestId("pixie-schedule-section-toggle"));

    await waitFor(() => expect(screen.getAllByTestId("pixie-schedule-row")).toHaveLength(2));
    expect(screen.getByText("每日构建报告")).toBeInTheDocument();
    expect(screen.getByText("every 1d")).toBeInTheDocument();
    expect(screen.getByText("手动巡检")).toBeInTheDocument();
    expect(screen.getByText("okxbot")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "每日构建报告" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "手动巡检" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // 创建入口只有「让精灵新建」——计划本身在对话里谈。
    expect(screen.getByText(/only views and toggles them/)).toBeInTheDocument();
  });

  it("开关直接落到 schedule.setJobEnabled", async () => {
    const user = userEvent.setup();
    render(<PixieScheduleSection />);
    await user.click(screen.getByTestId("pixie-schedule-section-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("pixie-schedule-row")).toHaveLength(2));

    await user.click(screen.getByRole("switch", { name: "手动巡检" }));

    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "schedule.setJobEnabled",
        expect.anything(),
        { id: "j2", enabled: true },
        expect.anything(),
      ),
    );
  });

  it("「＋ 让精灵新建」只把引导语塞进输入框，不新开会话", async () => {
    const user = userEvent.setup();
    render(<PixieScheduleSection />);

    await user.click(screen.getByTestId("pixie-schedule-new"));

    expect(requestComposerInsert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestComposerInsert).mock.calls[0][0]).toContain("Create a scheduled plan");
    // 折叠态点「＋」顺手展开，用户能看到现有计划。
    expect(section()).toHaveAttribute("data-open", "true");
    expect(hostClient.request).not.toHaveBeenCalledWith(
      "schedule.createJob",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("插件报调度器不可用时给出提示，不再展示列表", async () => {
    vi.mocked(hostClient.request).mockImplementation(async (method) => {
      if (method === "schedule.status") {
        return { ok: true, result: { available: false } } as never;
      }
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<PixieScheduleSection />);

    await user.click(screen.getByTestId("pixie-schedule-section-toggle"));

    await waitFor(() =>
      expect(screen.getByText("Schedule plugin not running")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("pixie-schedule-row")).toBeNull();
  });
});
