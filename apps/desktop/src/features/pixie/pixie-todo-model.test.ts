import { describe, expect, it } from "vitest";
import type { MemoNote } from "@piabyss/protocol";
import { groupTodoNotes, todoBucketOf, todoOverview, todoTabNotes } from "./pixie-todo-model";

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  return {
    id: "n1",
    title: "t",
    contentMd: "t",
    status: "open",
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    result: null,
    deletedAt: null,
    dueAt: null,
    recurrence: null,
    nextDueAt: null,
    lastDoneAt: null,
    ...overrides,
  } as MemoNote;
}

/** 固定的「现在」：2026-10-16 10:00（本地时区）。 */
const NOW = new Date(2026, 9, 16, 10, 0, 0).getTime();
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour, 0, 0).getTime();

describe("todoBucketOf", () => {
  it.each([
    ["逾期", at(2026, 10, 15), "overdue"],
    ["今天（当天晚些时候）", at(2026, 10, 16, 18), "today"],
    ["明天", at(2026, 10, 17), "tomorrow"],
    ["本周（第 5 天）", at(2026, 10, 20), "week"],
    ["更晚（超过一周）", at(2026, 11, 1), "later"],
  ] as const)("截止在%s落到 %s", (_label, dueAt, expected) => {
    expect(todoBucketOf(note({ dueAt }), NOW)).toBe(expected);
  });

  it("没有截止时刻的落到「无日期」", () => {
    expect(todoBucketOf(note(), NOW)).toBe("none");
  });

  it("周期记录看下一轮，不看一次性截止", () => {
    const recurring = note({
      dueAt: at(2026, 10, 15),
      recurrence: {
        frequency: "daily",
        interval: 1,
        weekdays: [],
        monthDay: null,
        time: "09:00",
        tz: "Asia/Shanghai",
        until: null,
        startDate: null,
      },
      nextDueAt: at(2026, 10, 17),
    });
    expect(todoBucketOf(recurring, NOW)).toBe("tomorrow");
  });

  it("刚好等于现在算逾期", () => {
    expect(todoBucketOf(note({ dueAt: NOW }), NOW)).toBe("overdue");
  });
});

describe("groupTodoNotes", () => {
  it("按紧迫度排分组，空分组不出现", () => {
    const notes = [
      note({ id: "a", dueAt: at(2026, 11, 1) }),
      note({ id: "b", dueAt: at(2026, 10, 15) }),
      note({ id: "c" }),
      note({ id: "d", dueAt: at(2026, 10, 16, 18) }),
    ];
    expect(groupTodoNotes(notes, NOW).map((group) => group.bucket)).toEqual([
      "overdue",
      "today",
      "later",
      "none",
    ]);
    expect(groupTodoNotes(notes, NOW)[0].notes.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("todoOverview", () => {
  it("待处理 = open + 进行中；已逾期只数未完成的", () => {
    const notes = [
      note({ id: "a", dueAt: at(2026, 10, 15) }),
      note({ id: "b", status: "in_progress" }),
      note({ id: "c", status: "done", completedAt: 1, dueAt: at(2026, 10, 15) }),
    ];
    expect(todoOverview(notes, NOW)).toEqual({ open: 2, overdue: 1 });
  });
});

describe("todoTabNotes", () => {
  it("进行中混在「待处理」里，已完成单独一档", () => {
    const notes = [
      note({ id: "a" }),
      note({ id: "b", status: "in_progress" }),
      note({ id: "c", status: "done" }),
    ];
    expect(todoTabNotes(notes, "open").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(todoTabNotes(notes, "done").map((entry) => entry.id)).toEqual(["c"]);
  });
});
