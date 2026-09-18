import { describe, expect, it } from "vitest";
import type { ScheduleJob } from "@piabyss/protocol";
import {
  defaultScheduleForm,
  formatCountdown,
  formatIntervalEvery,
  jobToForm,
  parseIntervalEvery,
  scheduleFormErrors,
  formToJobInput,
  toDatetimeLocalValue,
  triggerSummary,
} from "./schedule-model";

function jobFixture(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "a1b2c3d4",
    name: "安全审查",
    prompt: "审查 src/",
    command: null,
    cwd: "C:/proj",
    enabled: true,
    permission: "read_only",
    model: null,
    trigger: { type: "cron", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    missedWindow: "catch_up_one",
    timeoutMs: 30 * 60 * 1000,
    maxRuns: null,
    loadExtensions: false,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "piabyss",
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    runCount: 0,
    terminated: null,
    ...overrides,
  };
}

describe("parseIntervalEvery", () => {
  it("parses m/h/d values", () => {
    expect(parseIntervalEvery("30m")).toEqual({ value: 30, unit: "m" });
    expect(parseIntervalEvery("2H")).toEqual({ value: 2, unit: "h" });
    expect(parseIntervalEvery("1d")).toEqual({ value: 1, unit: "d" });
  });

  it("falls back to 30m for malformed input", () => {
    expect(parseIntervalEvery("nope")).toEqual({ value: 30, unit: "m" });
  });

  it("parses second/week/month units", () => {
    expect(parseIntervalEvery("15s")).toEqual({ value: 15, unit: "s" });
    expect(parseIntervalEvery("2w")).toEqual({ value: 2, unit: "w" });
    expect(parseIntervalEvery("1MO")).toEqual({ value: 1, unit: "mo" });
  });
});

describe("formatIntervalEvery", () => {
  it("compacts minutes into hours", () => {
    expect(formatIntervalEvery("90m")).toBe("1h30m");
    expect(formatIntervalEvery("120m")).toBe("2h");
    expect(formatIntervalEvery("2h")).toBe("2h");
    expect(formatIntervalEvery("1d")).toBe("1d");
    expect(formatIntervalEvery("15s")).toBe("15s");
    expect(formatIntervalEvery("2w")).toBe("2w");
    expect(formatIntervalEvery("1mo")).toBe("1mo");
  });
});

describe("triggerSummary", () => {
  it("maps each trigger shape", () => {
    expect(triggerSummary({ type: "manual" })).toEqual({ kind: "manual", value: null });
    expect(triggerSummary({ type: "once", at: "2026-01-01T09:00:00.000Z" })).toEqual({
      kind: "once",
      value: "2026-01-01T09:00:00.000Z",
    });
    expect(triggerSummary({ type: "interval", every: "30m" })).toEqual({
      kind: "interval",
      value: "30m",
    });
    expect(triggerSummary({ type: "cron", cron: "0 9 * * 1-5" })).toEqual({
      kind: "cron",
      value: "0 9 * * 1-5",
    });
  });
});

describe("formToJobInput", () => {
  it("builds a cron prompt task", () => {
    const form = {
      ...defaultScheduleForm("C:/proj"),
      name: "  安全审查  ",
      prompt: "审查 src/",
      triggerType: "cron" as const,
      cron: "0 9 * * 1-5",
      cronTimezone: "Asia/Shanghai",
      tags: "安全, 每日",
    };
    const parsed = formToJobInput(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.name).toBe("安全审查");
    expect(parsed.input.command).toBeNull();
    expect(parsed.input.trigger).toEqual({
      type: "cron",
      cron: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
    });
    expect(parsed.input.tags).toEqual(["安全", "每日"]);
    expect(parsed.input.timeoutMs).toBe(30 * 60 * 1000);
  });

  it("builds a command task with null prompt and no timezone when empty", () => {
    const form = {
      ...defaultScheduleForm("C:/proj"),
      kind: "command" as const,
      command: "git status",
      triggerType: "interval" as const,
      intervalValue: 2,
      intervalUnit: "h" as const,
    };
    const parsed = formToJobInput(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.prompt).toBe("");
    expect(parsed.input.command).toBe("git status");
    expect(parsed.input.trigger).toEqual({ type: "interval", every: "2h" });
  });

  it("rejects malformed cron / maxRuns / once", () => {
    const base = defaultScheduleForm("C:/proj");
    expect(
      formToJobInput({ ...base, name: "x", prompt: "y", triggerType: "cron", cron: "0 9" }).ok,
    ).toBe(false);
    expect(formToJobInput({ ...base, name: "x", prompt: "y", maxRuns: "0" }).ok).toBe(false);
    expect(
      formToJobInput({ ...base, name: "x", prompt: "y", triggerType: "once", onceAt: "" }).ok,
    ).toBe(false);
    expect(
      formToJobInput({
        ...base,
        name: "x",
        prompt: "y",
        triggerType: "once",
        onceAt: "2026-01-01T09:00",
      }).ok,
    ).toBe(true);
  });
});

describe("jobToForm roundtrip", () => {
  it("restores the form from a job", () => {
    const job = jobFixture({
      trigger: { type: "interval", every: "90m" },
      maxRuns: 5,
      tags: ["安全"],
    });
    const form = jobToForm(job);
    expect(form.kind).toBe("prompt");
    expect(form.intervalValue).toBe(90);
    expect(form.intervalUnit).toBe("m");
    expect(form.maxRuns).toBe("5");
    expect(form.tags).toBe("安全");
    const parsed = formToJobInput(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.trigger).toEqual({ type: "interval", every: "90m" });
    expect(parsed.input.maxRuns).toBe(5);
  });

  it("detects command tasks", () => {
    const form = jobToForm(jobFixture({ command: "git pull", prompt: "" }));
    expect(form.kind).toBe("command");
  });
});

describe("scheduleFormErrors", () => {
  it("flags missing required fields", () => {
    const errors = scheduleFormErrors(defaultScheduleForm(""));
    expect(errors.name).toBe("scheduleFormNameRequired");
    expect(errors.prompt).toBe("scheduleFormPromptRequired");
    expect(errors.cwd).toBe("scheduleFormCwdRequired");
  });

  it("passes for a complete form", () => {
    const errors = scheduleFormErrors({
      ...defaultScheduleForm("C:/proj"),
      name: "x",
      prompt: "y",
    });
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

describe("time helpers", () => {
  it("converts ISO to datetime-local in local time and back", () => {
    const iso = "2026-06-01T01:00:00.000Z";
    const local = toDatetimeLocalValue(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Round-trip preserves the instant (minute precision).
    expect(new Date(local).getTime()).toBe(
      new Date(iso).getTime() -
        (new Date(iso).getSeconds() * 1000 + new Date(iso).getMilliseconds()),
    );
  });

  it("formats countdown buckets", () => {
    const now = Date.now();
    expect(formatCountdown(new Date(now + 30_000).toISOString(), now)).toBe("<1m");
    expect(formatCountdown(new Date(now + 5 * 60_000).toISOString(), now)).toBe("5m");
    expect(formatCountdown(new Date(now + 2 * 3_600_000).toISOString(), now)).toBe("2h0m");
    expect(formatCountdown(new Date(now - 60_000).toISOString(), now)).toBe("due");
    expect(formatCountdown(null, now)).toBeNull();
  });
});

describe("stripPlanBlocks", () => {
  it("strips closed schedule-plan fences and keeps surrounding text", async () => {
    const { stripPlanBlocks } = await import("./ScheduleAgentPage");
    const text = [
      "好的，配置如下，请确认。",
      "```schedule-plan",
      '{"name":"安全审查"}',
      "```",
      "如需调整请告诉我。",
    ].join("\n");
    expect(stripPlanBlocks(text)).toBe("好的，配置如下，请确认。\n\n如需调整请告诉我。");
  });

  it("strips an unclosed streaming fence tail", async () => {
    const { stripPlanBlocks } = await import("./ScheduleAgentPage");
    const text = '已更新配置。\n```schedule-plan\n{"na';
    expect(stripPlanBlocks(text)).toBe("已更新配置。");
  });

  it("keeps ordinary code fences intact", async () => {
    const { stripPlanBlocks } = await import("./ScheduleAgentPage");
    const text = "```bash\ngit status\n```";
    expect(stripPlanBlocks(text)).toBe(text);
  });

  it("returns empty for a plan-only message", async () => {
    const { stripPlanBlocks } = await import("./ScheduleAgentPage");
    const text = '```schedule-plan\n{"name":"x"}\n```';
    expect(stripPlanBlocks(text)).toBe("");
  });
});

describe("splitUserMessage", () => {
  it("splits sentinel-wrapped preamble from the requirement", async () => {
    const { splitUserMessage } = await import("./ScheduleAgentPage");
    const text = [
      "<schedule-preamble>",
      "你是「周期计划」智能创建助手。",
      "计划的默认工作目录（cwd）：C:/proj",
      "</schedule-preamble>",
      "用户需求：",
      "每天早上九点审查代码",
    ].join("\n");
    const split = splitUserMessage(text);
    expect(split.preamble).toBe(
      "你是「周期计划」智能创建助手。\n计划的默认工作目录（cwd）：C:/proj",
    );
    expect(split.requirement).toBe("每天早上九点审查代码");
  });

  it("falls back to the 用户需求 marker for legacy transcripts", async () => {
    const { splitUserMessage } = await import("./ScheduleAgentPage");
    const split = splitUserMessage("你是助手。\n\n用户需求：\n每天备份");
    expect(split.preamble).toBe("你是助手。");
    expect(split.requirement).toBe("每天备份");
  });

  it("returns the text untouched when nothing matches", async () => {
    const { splitUserMessage } = await import("./ScheduleAgentPage");
    const split = splitUserMessage("就一句话");
    expect(split.preamble).toBeNull();
    expect(split.requirement).toBe("就一句话");
  });
});

describe("buildScheduleRows", () => {
  const message = (
    role: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): { role: string; text: string; [key: string]: unknown } => ({ role, text, ...extra });

  it("renders a tool call as a transcript tool block with its result settled", async () => {
    const { buildScheduleRows } = await import("./ScheduleAgentPage");
    const rows = buildScheduleRows(
      [
        message("user", "你能执行工具吗"),
        message("assistant", "", {
          content: [
            { type: "thinking", thinking: "先看一眼目录" },
            { type: "toolCall", id: "call-1", name: "ls", arguments: { path: "." } },
          ],
        }),
        message("toolResult", "apps\npackages", {
          content: [{ type: "text", text: "apps\npackages" }],
          toolCallId: "call-1",
          toolName: "ls",
        }),
      ],
      "计划配置已更新",
      false,
    );

    // Assistant message + its tool result merge into one turn row, exactly
    // like the workspace transcript's projection.
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const blocks = rows[1].blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["thinking", "tool"]);
    const tool = blocks[1];
    if (tool.kind !== "tool") throw new Error("expected a tool block");
    expect(tool.tool).toMatchObject({ id: "call-1", name: "ls", status: "done" });
  });

  it("keeps a still-running tool open while the turn is active", async () => {
    const { buildScheduleRows } = await import("./ScheduleAgentPage");
    const messages = [
      message("user", "查内存"),
      message("assistant", "我来查一下", {
        content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }],
      }),
    ];
    const active = buildScheduleRows(messages, "x", true)[1].blocks[0];
    const settled = buildScheduleRows(messages, "x", false)[1].blocks[0];
    if (active.kind !== "tool" || settled.kind !== "tool") throw new Error("expected tool blocks");
    expect(active.tool.status).toBe("waiting");
    expect(settled.tool.status).toBe("aborted");
  });

  it("marks a plan-only reply inline and strips the plan block from the answer", async () => {
    const { buildScheduleRows } = await import("./ScheduleAgentPage");
    const planOnly = buildScheduleRows(
      [message("assistant", '```schedule-plan\n{"name":"x"}\n```')],
      "计划配置已更新",
      false,
    );
    expect(planOnly[0].blocks).toEqual([{ kind: "text", text: "计划配置已更新" }]);

    const mixed = buildScheduleRows(
      [message("assistant", '好的：\n```schedule-plan\n{"name":"x"}\n```')],
      "计划配置已更新",
      false,
    );
    expect(mixed[0].blocks).toEqual([{ kind: "text", text: "好的：" }]);
  });

  it("strips the injected preamble from the first user bubble", async () => {
    const { buildScheduleRows } = await import("./ScheduleAgentPage");
    const rows = buildScheduleRows(
      [
        message(
          "user",
          [
            "<schedule-preamble>",
            "你是「周期计划」智能创建助手。",
            "</schedule-preamble>",
            "用户需求：",
            "每天早上九点审查代码",
          ].join("\n"),
        ),
      ],
      "x",
      false,
    );
    expect(rows[0].blocks).toEqual([{ kind: "text", text: "每天早上九点审查代码" }]);
  });
});
