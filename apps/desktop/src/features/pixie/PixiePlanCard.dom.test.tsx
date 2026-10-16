/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, ScheduleJob, WorkspaceSnapshot } from "@piabyss/protocol";
import { PLAN_RECEIPT_CUSTOM_TYPE } from "../schedule/schedule-plan-fence";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { PixiePlanCard } from "./PixiePlanCard";

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: { request: vi.fn() },
}));

const DRAFT = {
  name: "每日构建报告",
  kind: "prompt",
  prompt: "总结昨天的提交",
  command: null,
  cwd: "/work/okxbot",
  trigger: { type: "interval", every: "1d" },
  permission: "read_only",
  model: null,
  missedWindow: "skip",
  timeoutMs: 60_000,
  maxRuns: null,
  tags: [],
  notify: "system",
};

function block(overrides: Record<string, unknown> = {}, key = "7:1") {
  return {
    kind: "plan",
    plan: { ...DRAFT, ...overrides },
    raw: JSON.stringify({ ...DRAFT, ...overrides }),
    key,
  } as never;
}

const CREATED_JOB = { id: "j9", name: "每日构建报告" } as ScheduleJob;

function seedSession(messages: unknown[] = []) {
  useAppStore.setState({
    host: { hostInstanceId: "h1", sessionId: "s1", sessionRevision: 1 } as HostStatusSnapshot,
    workspace: { id: "w1", revision: 1, canonicalCwd: "/work/pixie" } as WorkspaceSnapshot,
    session: { sessionId: "s1", revision: 1, messages } as never,
  });
}

beforeEach(() => {
  vi.mocked(hostClient.request).mockReset();
  seedSession();
});

afterEach(() => {
  cleanup();
});

describe("PixiePlanCard", () => {
  it("待确认时给出草案行与三个动作，确认走 createJob 再补回执", async () => {
    const user = userEvent.setup();
    vi.mocked(hostClient.request).mockImplementation(async (method) => {
      if (method === "schedule.createJob")
        return { ok: true, result: { job: CREATED_JOB } } as never;
      if (method === "session.appendCustomMessage")
        return { ok: true, result: { appended: true } } as never;
      return { ok: true, result: null } as never;
    });

    render(<PixiePlanCard block={block()} />);

    expect(screen.getByRole("heading", { name: "每日构建报告" })).toBeInTheDocument();
    await user.click(screen.getByTestId("pixie-plan-confirm"));

    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "schedule.createJob",
        expect.anything(),
        expect.objectContaining({ name: "每日构建报告" }),
        expect.anything(),
      ),
    );
    // 回执必须落在会话里（她下一轮读得到），且带着这张卡的 key。
    expect(hostClient.request).toHaveBeenCalledWith(
      "session.appendCustomMessage",
      expect.anything(),
      expect.objectContaining({
        customType: PLAN_RECEIPT_CUSTOM_TYPE,
        details: expect.objectContaining({ planKey: "7:1", jobId: "j9" }),
      }),
      expect.anything(),
    );
  });

  it("草案带 jobId 就更新原计划，而不是再建一条重复的", async () => {
    const user = userEvent.setup();
    vi.mocked(hostClient.request).mockImplementation(async (method) => {
      if (method === "schedule.updateJob")
        return { ok: true, result: { job: CREATED_JOB } } as never;
      if (method === "session.appendCustomMessage")
        return { ok: true, result: { appended: true } } as never;
      return { ok: true, result: null } as never;
    });

    render(<PixiePlanCard block={block({ jobId: "j9" })} />);
    await user.click(screen.getByTestId("pixie-plan-confirm"));

    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "schedule.updateJob",
        expect.anything(),
        expect.objectContaining({ id: "j9" }),
        expect.anything(),
      ),
    );
    expect(hostClient.request).not.toHaveBeenCalledWith(
      "schedule.createJob",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("会话里已有回执 → 卡片只余状态，不留第二次落库的机会", () => {
    seedSession([
      {
        role: "custom",
        customType: PLAN_RECEIPT_CUSTOM_TYPE,
        display: true,
        details: { planKey: "7:1", action: "created", jobId: "j9", name: "每日构建报告" },
      },
    ]);

    render(<PixiePlanCard block={block()} />);

    expect(screen.getByTestId("pixie-plan-card").dataset.state).toBe("created");
    expect(screen.queryByTestId("pixie-plan-confirm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pixie-plan-cancel")).not.toBeInTheDocument();
  });

  it("更晚还有一份草案时，老的待确认卡标为被取代且不可点", () => {
    // key 里的消息序号是会话里的绝对序号：0:1 之后又来了 1:1，0:1 就不再是当前草案。
    seedSession([
      {
        role: "assistant",
        content: "第一版：\n```schedule-plan\n" + JSON.stringify(DRAFT) + "\n```",
      },
      {
        role: "assistant",
        content: "第二版：\n```schedule-plan\n" + JSON.stringify(DRAFT) + "\n```",
      },
    ]);

    render(<PixiePlanCard block={block({}, "0:1")} />);

    expect(screen.getByTestId("pixie-plan-card").dataset.state).toBe("superseded");
    expect(screen.queryByTestId("pixie-plan-confirm")).not.toBeInTheDocument();
  });

  it("JSON 读不动也要露出原文，不能静默把模型的话吞掉", () => {
    render(
      <PixiePlanCard block={{ kind: "plan", plan: null, raw: "{ 坏掉的", key: "3:1" } as never} />,
    );

    expect(screen.getByTestId("pixie-plan-card-invalid")).toBeInTheDocument();
    expect(hostClient.request).not.toHaveBeenCalled();
  });
});
