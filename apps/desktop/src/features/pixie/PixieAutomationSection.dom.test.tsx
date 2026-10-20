/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  AutomationJob,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { requestComposerInsert } from "../../lib/composer-insert";
import { useAppStore } from "../../lib/stores/app-store";
import { PixieAutomationSection } from "./PixieAutomationSection";

/**
 * 随行面板「自动化」页签：列表直接摊开，工具条一行说清「下次什么时候」（活跃数交给
 * 页签徽章），开关就地生效，点行开详情弹窗，「＋」开新建弹窗（两种模式都在里面）。
 * 面板的插件门与页签栏归 `PixieSidePanel`（见它的用例）。
 */
const onCount = vi.fn();

vi.mock("../../lib/composer-insert", () => ({
  requestComposerInsert: vi.fn(),
}));

const PIXIE_CWD = "/agent/workspace/pixie";
const NEXT_RUN_AT = new Date(Date.now() + 2 * 3_600_000).toISOString();

function job(overrides: Partial<AutomationJob> = {}): AutomationJob {
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
  } as AutomationJob;
}

const JOBS: AutomationJob[] = [
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
  return screen.getByTestId("pixie-panel-body-automation");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "automation.status") return { ok: true, result: { available: true } } as never;
    if (method === "automation.listJobs") {
      return { ok: true, result: { jobs: JOBS, activeJobIds: [] } } as never;
    }
    if (method === "automation.setJobEnabled") {
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

describe("PixieAutomationSection", () => {
  it("摊开就是列表：工具条说清下次触发，活跃数报给页签徽章", async () => {
    render(<PixieAutomationSection active onCount={onCount} />);

    // 计数徽章 = 活跃计划数（停用的不算）。
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
    // 工具条那一行说清「下次什么时候」：倒计时按现在算，取到「NhNm」即可。
    await waitFor(() => expect(section().textContent).toMatch(/next in \d+h\d+m/));
    // 二级页签：默认只看「当前活跃」那一桶，停用的一条不在屏上。
    await waitFor(() => expect(screen.getAllByTestId("pixie-automation-row")).toHaveLength(1));
  });

  it("列表给全：名称 / 触发 / 倒计时 / 工作区 / 开关", async () => {
    render(<PixieAutomationSection active onCount={onCount} />);

    await waitFor(() => expect(screen.getAllByTestId("pixie-automation-row")).toHaveLength(1));
    expect(screen.getByText("每日构建报告")).toBeInTheDocument();
    expect(screen.getByText("every 1d")).toBeInTheDocument();
    expect(screen.getByText("okxbot")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "每日构建报告" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("开关直接落到 automation.setJobEnabled", async () => {
    const user = userEvent.setup();
    render(<PixieAutomationSection active onCount={onCount} />);
    // 停用那条归「已失效」桶，先切过去才看得见它的开关。
    await user.click(await screen.findByTestId("pixie-automation-tab-expired"));
    await waitFor(() => expect(screen.getAllByTestId("pixie-automation-row")).toHaveLength(1));

    await user.click(screen.getByRole("switch", { name: "手动巡检" }));

    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "automation.setJobEnabled",
        expect.anything(),
        { id: "j2", enabled: true },
        expect.anything(),
      ),
    );
  });

  it("「＋」开新建弹窗（两种模式都在里面），不直接建任务也不塞输入框", async () => {
    const user = userEvent.setup();
    render(<PixieAutomationSection active onCount={onCount} />);

    await user.click(screen.getByTestId("pixie-automation-new"));

    // 弹窗默认落在「智能」模式：需求写进去后交给小精灵出草案，落库仍在卡片上。
    expect(await screen.findByTestId("automation-form-smart-requirement")).toBeInTheDocument();
    expect(requestComposerInsert).not.toHaveBeenCalled();
    expect(hostClient.request).not.toHaveBeenCalledWith(
      "automation.createJob",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("智能模式：引导语放进输入框由用户发送，不替用户发一条消息进对话", async () => {
    const user = userEvent.setup();
    render(<PixieAutomationSection active onCount={onCount} />);
    await user.click(screen.getByTestId("pixie-automation-new"));

    await user.type(
      await screen.findByTestId("automation-form-smart-requirement"),
      "每天早9点总结昨天的提交",
    );
    await user.click(screen.getByRole("button", { name: "Start analysis" }));

    await waitFor(() => expect(requestComposerInsert).toHaveBeenCalledTimes(1));
    const inserted = vi.mocked(requestComposerInsert).mock.calls[0][0];
    expect(inserted).toContain("每天早9点总结昨天的提交");
    // 默认工作区一起带进框里，用户不用自己找路径
    expect(inserted).toContain(PIXIE_CWD);
    // 这条老路必须彻底没有：程序代发用户消息既改不了也撤回不了
    expect(hostClient.request).not.toHaveBeenCalledWith(
      "agent.prompt",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("二级页签分桶：停用的归「已失效」，计数挂在标签上", async () => {
    const user = userEvent.setup();
    render(<PixieAutomationSection active onCount={onCount} />);

    const activeTab = await screen.findByTestId("pixie-automation-tab-active");
    const expiredTab = screen.getByTestId("pixie-automation-tab-expired");
    // 「＋」与两桶在同一行：这一行就是这一块的唯一工具条，不再单开一条 hint 行。
    // （同行不等于同父：两桶靠左成一组文字、动作贴右成一组，外层那个 flex 行才是工具条。）
    const tabbar = screen.getByTestId("pixie-automation-tabbar");
    for (const element of [activeTab, expiredTab, screen.getByTestId("pixie-automation-new")]) {
      expect(tabbar).toContainElement(element);
    }
    expect(activeTab).toHaveAttribute("aria-pressed", "true");
    expect(activeTab.textContent).toContain("1");
    expect(expiredTab.textContent).toContain("1");
    expect(screen.queryByText("手动巡检")).not.toBeInTheDocument();

    await user.click(expiredTab);

    expect(expiredTab).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getAllByTestId("pixie-automation-row")).toHaveLength(1));
    expect(screen.getByText("手动巡检")).toBeInTheDocument();
    // 页签徽章仍然只数活跃那一条。
    expect(onCount).toHaveBeenLastCalledWith(1);
  });

  it("僵尸的 running 记录：说「已中断」而不是继续画执行中，也不给停止按钮", async () => {
    const user = userEvent.setup();
    vi.mocked(hostClient.request).mockImplementation(async (method) => {
      if (method === "automation.status") return { ok: true, result: { available: true } } as never;
      if (method === "automation.listJobs") {
        return { ok: true, result: { jobs: JOBS, activeJobIds: [] } } as never;
      }
      if (method === "automation.listRuns") {
        return {
          ok: true,
          result: {
            runs: [
              {
                runId: "r1",
                jobId: "j1",
                jobName: "每日构建报告",
                trigger: "interval",
                status: "running",
                startedAt: new Date().toISOString(),
                finishedAt: null,
                durationMs: null,
                model: null,
                permission: "read_only",
                tools: ["read"],
                sessionPath: null,
                command: null,
                forkOf: null,
                summary: "",
                error: null,
                usage: null,
                toolCalls: 0,
              },
            ],
          },
        } as never;
      }
      return { ok: true, result: null } as never;
    });

    render(<PixieAutomationSection active onCount={onCount} />);
    await user.click(await screen.findByText("每日构建报告"));

    // `status:"running"` 单独不作数：调度器（activeJobIds）里没有这一条，就是宿主
    // 中途退出留下的僵尸记录。给它画「执行中」+ 一个点了只会报 409 的停止按钮，
    // 等于把坏掉的数据结构转嫁给用户。
    expect(await screen.findByText(/Interrupted/)).toBeInTheDocument();
    expect(screen.queryByTestId("pixie-detail-stop")).not.toBeInTheDocument();
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
  });

  it("执行历史标出触发来源与 token 用量", async () => {
    const user = userEvent.setup();
    vi.mocked(hostClient.request).mockImplementation(async (method) => {
      if (method === "automation.status") return { ok: true, result: { available: true } } as never;
      if (method === "automation.listJobs") {
        return { ok: true, result: { jobs: JOBS, activeJobIds: [] } } as never;
      }
      if (method === "automation.listRuns") {
        return {
          ok: true,
          result: {
            runs: [
              {
                runId: "r1",
                jobId: "j1",
                jobName: "每日构建报告",
                // 排期自己触发的那几种才标来源：manual / reply 是用户当下做的。
                trigger: "cron",
                status: "ok",
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 12_000,
                model: null,
                permission: "read_only",
                tools: ["read"],
                sessionPath: null,
                command: null,
                forkOf: null,
                summary: "构建成功",
                error: null,
                usage: { input: 1200, output: 800, total: 2000, cost: 0 },
                toolCalls: 1,
              },
            ],
          },
        } as never;
      }
      return { ok: true, result: null } as never;
    });

    render(<PixieAutomationSection active onCount={onCount} />);
    await user.click(await screen.findByText("每日构建报告"));

    // 与工具审计同排：一起回答「这一轮怎么跑起来的、给了什么工具、花了多少」。
    expect(await screen.findByText("Cron")).toBeInTheDocument();
    expect(await screen.findByText(/tok$/)).toBeInTheDocument();
  });

  it("点行打开详情弹窗，开关那一格不会跟着打开", async () => {
    const user = userEvent.setup();
    render(<PixieAutomationSection active onCount={onCount} />);
    await user.click(await screen.findByTestId("pixie-automation-tab-expired"));
    await waitFor(() => expect(screen.getAllByTestId("pixie-automation-row")).toHaveLength(1));

    await user.click(screen.getByText("手动巡检"));

    expect(await screen.findByText("Run history")).toBeInTheDocument();
    // 关闭入口只有右上角那一个 ❌：底部不再排「关闭」，动作条只放动作。
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(hostClient.request).toHaveBeenCalledWith(
      "automation.listRuns",
      expect.anything(),
      expect.objectContaining({ jobId: "j2" }),
      expect.anything(),
    );
  });

  it("插件报调度器不可用时给出提示，不再展示列表", async () => {
    vi.mocked(hostClient.request).mockImplementation(async (method) => {
      if (method === "automation.status") {
        return { ok: true, result: { available: false } } as never;
      }
      return { ok: true, result: null } as never;
    });
    render(<PixieAutomationSection active onCount={onCount} />);

    await waitFor(() =>
      expect(screen.getByText("Automation plugin not running")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("pixie-automation-row")).toBeNull();
  });
});
