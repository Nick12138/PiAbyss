/**
 * 随行面板「待办 · 方寸间」的纯模型：日期分组、概览计数、时间输入框的互转。
 *
 * 与方寸间页（`MemoPage`）共用 `memo-model` 的判定（逾期、排序、标题/标签派生），
 * 这里只补面板特有的两块：按「逾期 / 今天 / 明天 / 本周 / 更晚 / 无日期」落位，
 * 以及待处理 / 逾期两个计数。全部纯函数，便于单测。
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

/** epoch ms → `<input type="datetime-local">` 的本地值（YYYY-MM-DDTHH:mm）。 */
export function datetimeLocalValue(timestamp: number | null): string {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** `<input type="datetime-local">` 的值 → epoch ms；空串 / 非法 = null（无截止）。 */
export function parseDatetimeLocal(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const timestamp = new Date(trimmed).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

/** 逗号分隔的标签输入 → 去空、去重（大小写不敏感）、保序。 */
export function parseTagInput(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of value.split(/[,，]/)) {
    const tag = part.trim().replace(/^#+/, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}
