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
    });
    expect(parsed.input.tags).toEqual(["安全", "每日"]);
    expect(parsed.input.timeoutMs).toBe(30 * 60 * 1000);
  });

  it("builds a command task with null prompt", () => {
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

describe("smart-creation preview", () => {
  // Same shape as the panel's `t`: identity lookup, so assertions read the key
  // instead of a translated string.
  const t = ((key: string, params?: Record<string, string | number>) =>
    params ? `${key}(${Object.values(params).join(",")})` : key) as never;

  it("resolves plugin defaults instead of reporting them undetermined", async () => {
    const { schedulePlanPreviewRows } = await import("./schedule-model");
    const rows = schedulePlanPreviewRows(
      { name: "内存监控", cwd: "D:/proj", trigger: { type: "manual" } },
      t,
      "hostDefaultModelLabel",
    );
    const byLabel = new Map(rows.map((row) => [row.label, row]));

    // The model has a real fallback: the host default.
    expect(byLabel.get("scheduleFormModel")).toMatchObject({
      value: "hostDefaultModelLabel",
      fallback: true,
    });
    // maxRuns null means "no cap", not "unknown".
    expect(byLabel.get("scheduleFormMaxRuns")).toMatchObject({
      value: "scheduleFormMaxRunsPlaceholder",
      fallback: true,
    });
    // timeoutMs null falls back to the plugin's 30-minute default.
    expect(byLabel.get("scheduleFormTimeout")?.value).toBe("scheduleTimeoutValue(30)");
    // No row may be left open when every required field is present.
    expect(rows.every((row) => row.value !== null)).toBe(true);
  });

  it("drops rows that do not apply to a command plan", async () => {
    const { schedulePlanPreviewRows } = await import("./schedule-model");
    const rows = schedulePlanPreviewRows(
      {
        kind: "command",
        name: "内存",
        command: "free -h",
        cwd: "/tmp",
        trigger: { type: "manual" },
      },
      t,
      "hostDefaultModelLabel",
    );
    const labels = rows.map((row) => row.label);
    // permission/model are prompt-only in the create path.
    expect(labels).not.toContain("scheduleFormPermission");
    expect(labels).not.toContain("scheduleFormModel");
    expect(rows.map((row) => row.value)).not.toContain(null);
  });

  it("reports only genuinely open required fields", async () => {
    const { schedulePlanMissingFields } = await import("./schedule-model");
    expect(
      schedulePlanMissingFields({ name: "n", cwd: "/p", trigger: { type: "manual" }, prompt: "x" }),
    ).toEqual([]);
    expect(schedulePlanMissingFields({})).toEqual([
      "scheduleFormName",
      "scheduleFormCwd",
      "scheduleFormTrigger",
      "scheduleFormPrompt",
    ]);
    // A command plan needs a command, not a prompt.
    expect(
      schedulePlanMissingFields({
        kind: "command",
        name: "n",
        cwd: "/p",
        trigger: { type: "manual" },
      }),
    ).toEqual(["scheduleFormCommand"]);
  });

  it("omits tags when the AI settled none", async () => {
    const { schedulePlanPreviewRows } = await import("./schedule-model");
    const rows = schedulePlanPreviewRows(
      { tags: [], name: "n", cwd: "/p", trigger: { type: "manual" }, prompt: "x" },
      t,
      "m",
    );
    expect(rows.map((row) => row.label)).not.toContain("scheduleFormTags");
  });
});
