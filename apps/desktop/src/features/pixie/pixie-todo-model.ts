/**
 * 随行面板「方寸间」的纯模型：日期分组与概览计数。
 *
 * 共用 `memo-model` 的判定（逾期、排序、标题/标签派生），这里只补面板特有的两块：
 * 按「逾期 / 今天 / 明天 / 本周 / 更晚 / 无日期」落位，以及待处理 / 逾期两个计数。
 * 新建与编辑的计划字段归 `MemoEditor`，面板不自己拼时间输入框，所以这里没有 datetime
 * 互转。全部纯函数，便于单测。
 */
import type { MemoNote } from "@piabyss/protocol";
import { isMemoOverdue } from "../memo/memo-model";

export type TodoBucket = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

/**
 * 分组的展示顺序。带截止的按紧迫度排（逾期 → 今天 → 明天 → 本周 → 更晚），
 * 没有时间的一律沉底：它们不该压住已经逾期的那几条。
 */
const TODO_BUCKET_ORDER: readonly TodoBucket[] = [
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
  "none",
];

const DAY_MS = 86_400_000;

/** 记录的计划时刻：周期记录看下一轮，一次性记录看截止；都没有 = 没时间。 */
export function todoTargetAt(note: MemoNote): number | null {
  return note.recurrence !== null ? note.nextDueAt : note.dueAt;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function todoBucketOf(note: MemoNote, now: number): TodoBucket {
  const target = todoTargetAt(note);
  if (target === null) return "none";
  if (target <= now) return "overdue";
  const today = startOfDay(now);
  if (target < today + DAY_MS) return "today";
  if (target < today + 2 * DAY_MS) return "tomorrow";
  if (target < today + 7 * DAY_MS) return "week";
  return "later";
}

export type TodoGroup = { bucket: TodoBucket; notes: MemoNote[] };

/** 按日期落位（空分组不返回）。传入的 notes 应当已经是「待处理」那一档。 */
export function groupTodoNotes(notes: readonly MemoNote[], now: number): TodoGroup[] {
  const buckets = new Map<TodoBucket, MemoNote[]>();
  for (const note of notes) {
    const bucket = todoBucketOf(note, now);
    const list = buckets.get(bucket);
    if (list) list.push(note);
    else buckets.set(bucket, [note]);
  }
  return TODO_BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) => ({
    bucket,
    notes: buckets.get(bucket)!,
  }));
}

export type TodoOverview = {
  /** 「待处理」= open + in_progress（进行中不单独分区，也不单独计数）。 */
  open: number;
  overdue: number;
};

export function todoOverview(notes: readonly MemoNote[], now: number): TodoOverview {
  let open = 0;
  let overdue = 0;
  for (const note of notes) {
    if (note.status === "done") continue;
    open += 1;
    if (isMemoOverdue(note, now)) overdue += 1;
  }
  return { open, overdue };
}

/** 面板里的「待处理 / 已完成」两档：进行中混在待处理里。 */
export function todoTabNotes(notes: readonly MemoNote[], tab: "open" | "done"): MemoNote[] {
  return notes.filter((note) => (tab === "done" ? note.status === "done" : note.status !== "done"));
}
