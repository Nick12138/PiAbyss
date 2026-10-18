import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createScheduleHandlers } from "./schedule-controller.js";
import { scheduleApi } from "./schedule-api.js";

vi.mock("./schedule-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schedule-api.js")>();
  return { ...actual, scheduleApi: vi.fn() };
});

const mockedApi = vi.mocked(scheduleApi);

let root = "";

function handler(method: string) {
  const handlers = createScheduleHandlers();
  const found = handlers[method];
  if (!found) throw new Error(`缺少方法：${method}`);
  return found;
}

async function call(method: string, params: unknown) {
  return handler(method)({ id: "r1", context: {}, params } as never);
}

/** MethodHandler 的成功分支只保证 `result: unknown`，测试里按各自的形状收窄。 */
function unwrap(result: unknown): Record<string, any> {
  if (typeof result !== "object" || result === null || !("result" in result)) {
    throw new Error("应当成功");
  }
  return (result as { result: Record<string, any> }).result;
}

function ok(data: unknown) {
  return { ok: true as const, status: 200, data };
}

beforeEach(() => {
  root = join(tmpdir(), `pi-schedule-host-${Math.random().toString(16).slice(2)}`);
  process.env.PI_SCHEDULE_DIR = root;
  mkdirSync(join(root, "sessions", "job1"), { recursive: true });
  mockedApi.mockReset();
});

afterEach(() => {
  delete process.env.PI_SCHEDULE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("schedule.abortRun", () => {
  it("走 /api/runs/:id/abort 并带回归一化后的 run", async () => {
    mockedApi.mockResolvedValue(
      ok({ aborted: true, run: { runId: "r", jobId: "job1", status: "running" } }) as never,
    );

    const result = await call("schedule.abortRun", { runId: "r" });

    expect(mockedApi).toHaveBeenCalledWith(
      "/api/runs/r/abort",
      "POST",
      expect.objectContaining({ body: {} }),
    );
    const payload = unwrap(result);
    expect(payload.aborted).toBe(true);
    // 老插件没有这三个字段也不能把面板弄崩：如实补空，不编造。
    expect(payload.run).toMatchObject({ tools: [], sessionPath: null, command: null });
  });

  it("这一轮已不在执行中（409）映射成可重试的 AGENT_BUSY，而不是 500", async () => {
    mockedApi.mockResolvedValue({
      ok: false,
      status: 409,
      error: "这一轮已不在执行中：r",
    } as never);

    const result = await call("schedule.abortRun", { runId: "r" });

    if (!("error" in result)) throw new Error("409 必须报错");
    expect(result.error.code).toBe("AGENT_BUSY");
    expect(result.error.retryable).toBe(true);
  });
});

describe("schedule.runMessages", () => {
  /** 一份带思考块与工具调用/结果的真实会话 jsonl（Host 读盘投影，不经插件的拍平端点）。 */
  function writeSession(path: string) {
    const lines = [
      { type: "session", id: "s1", cwd: "C:/tmp", parentSession: null },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-16T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "先看目录" },
            { type: "text", text: "我读一下" },
            { type: "toolCall", id: "t1", name: "read", args: { path: "a.ts" } },
          ],
        },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-10-16T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "read",
          content: [{ type: "text", text: "文件内容在此" }],
        },
      },
    ];
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  }

  it("会话落在插件数据根内：读盘并保留工具调用与结果的关联", async () => {
    const sessionPath = join(root, "sessions", "job1", "run.jsonl");
    writeSession(sessionPath);
    mockedApi.mockResolvedValue(
      ok({ run: { runId: "r", status: "running", sessionPath } }) as never,
    );

    const payload = unwrap(await call("schedule.runMessages", { runId: "r" }));

    expect(payload.found).toBe(true);
    expect(payload.running).toBe(true);
    const assistant = payload.messages.find(
      (message: Record<string, any>) => message.role === "assistant",
    );
    // 拍平视图会丢掉的东西必须还在：思考块、工具调用、以及 toolResult 的关联。
    expect(
      assistant?.content?.some((block: Record<string, any>) => block.type === "thinking"),
    ).toBe(true);
    expect(
      assistant?.content?.some((block: Record<string, any>) => block.type === "toolCall"),
    ).toBe(true);
    const toolResult = payload.messages.find(
      (message: Record<string, any>) => message.role === "toolResult",
    );
    expect(toolResult?.toolCallId).toBe("t1");
    expect(toolResult?.text).toContain("文件内容在此");
  });

  it("会话路径想逃出插件数据根：拒绝读盘，也不报成加载失败", async () => {
    const secret = join(root, "..", "elsewhere.jsonl");
    mockedApi.mockResolvedValue(
      ok({ run: { runId: "r", status: "ok", sessionPath: secret } }) as never,
    );

    const payload = unwrap(await call("schedule.runMessages", { runId: "r" }));

    expect(payload.found).toBe(false);
    expect(payload.sessionPath).toBeNull();
    expect(payload.messages).toEqual([]);
  });

  it("命令型任务没有会话：found=false 是如实结果", async () => {
    mockedApi.mockResolvedValue(
      ok({ run: { runId: "r", status: "ok", sessionPath: null, command: "dir" } }) as never,
    );

    expect(unwrap(await call("schedule.runMessages", { runId: "r" })).found).toBe(false);
  });
});

describe("schedule.listRuns 字段兜底", () => {
  it("插件版本落后时补空值，字段齐全时原样透出", async () => {
    mockedApi.mockResolvedValue(
      ok({
        runs: [
          { runId: "old", jobId: "job1", status: "ok" },
          {
            runId: "new",
            jobId: "job1",
            status: "ok",
            tools: ["read", "grep"],
            sessionPath: "C:/x.jsonl",
            command: null,
          },
        ],
      }) as never,
    );

    const [oldRun, newRun] = unwrap(await call("schedule.listRuns", { jobId: "job1" })).runs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(oldRun.tools).toEqual([]);
    expect(oldRun.sessionPath).toBeNull();
    expect(newRun.tools).toEqual(["read", "grep"]);
    expect(newRun.sessionPath).toBe("C:/x.jsonl");
  });
});
