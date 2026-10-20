/**
 * 会话开场（preamble）模型：把「用户第一句话之前那一坨系统物料」从消息流里
 * 抽出来，折成一张卡。
 *
 * 三块来源：
 * 1. `system` 消息（SDK 会话 v3 落盘的系统提示词）——每次工具集变化都会再写
 *    一条**增量**（只含变化的小节），所以这里按小节做 last-wins 合并，只留一份。
 * 2. 段首用户消息外面的 `<pixie-context>` 契约——Host 注入，用户没写过。
 * 3. `<pixie-segments>` 上一段交接卡（插件写入的 custom message）——落盘顺序
 *    排在首条用户消息后面 2ms，行序上却属于"开场"，所以按"首个 assistant 之前"
 *    认定，避免把它留在对话中间。
 *
 * 只有凑够两块才折叠：普通会话只有系统提示词，保持原来的单行样式不动。
 * 纯函数，渲染在 `TranscriptPreamble`。
 */
import {
  PIXIE_SEGMENTS_CUSTOM_TYPE,
  parseUserAttachments,
  type TranscriptRow,
} from "./transcript-model";

/** 回顾卡里的一行：`0. 😀 Qoder反代项目推荐 · 10-19 12:47 · 65 条`。 */
type PixieSegmentSummary = {
  index: number;
  title: string;
  /** 时间和条数原样保留（卡片文案由插件生成，别在这里翻译单位）。 */
  meta: string;
};

export type PixieSegmentsRecap = {
  /** 「最近 N 段」之前的那段说明。 */
  intro: string;
  entries: PixieSegmentSummary[];
  /** 「上一段（…）的收尾：」这一行，插件自带，直接显示。 */
  tailHeading: string;
  /** 收尾正文（原始行，未做 Markdown 解释）。 */
  tail: string;
  /** 剥掉 `<pixie-segments>` 外壳的全文，解析失败时兜底。 */
  text: string;
};

const PIXIE_SEGMENTS_WRAPPER = /<\/?pixie-segments>/gu;
// 标题里也可能出现 ` · `，所以从行尾往前锚定「时间 · 条数」。
const RECAP_ENTRY =
  /^\s*(\d+)\.\s+(.+?)\s+·\s+(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s+·\s+(\d+)\s*条\s*$/u;
const RECAP_HEADING_LINE = /^最近\s*\d+\s*段/u;
const RECAP_TAIL_LINE = /的收尾[：:]\s*$/u;

export function parsePixieSegmentsRecap(raw: string): PixieSegmentsRecap {
  const text = raw.replace(PIXIE_SEGMENTS_WRAPPER, "").trim();
  const lines = text.split(/\r?\n/);
  let entriesStart = -1;
  let tailStart = -1;
  const entries: PixieSegmentSummary[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = RECAP_ENTRY.exec(line);
    if (match) {
      if (entriesStart === -1) entriesStart = index;
      entries.push({
        index: Number(match[1]),
        title: (match[2] ?? "").trim(),
        meta: `${match[3] ?? ""} · ${match[4] ?? ""} 条`,
      });
      continue;
    }
    if (RECAP_TAIL_LINE.test(line)) {
      tailStart = index;
      break;
    }
  }
  const introEnd =
    entriesStart === -1 ? (tailStart === -1 ? lines.length : tailStart) : entriesStart;
  const intro = lines
    .slice(0, introEnd)
    .filter((line) => !RECAP_HEADING_LINE.test(line))
    .join("\n")
    .trim();
  const tailHeading = tailStart === -1 ? "" : (lines[tailStart] ?? "").trim();
  const tail =
    tailStart === -1
      ? ""
      : lines
          .slice(tailStart + 1)
          .join("\n")
          .trim();
  return { intro, entries, tailHeading, tail, text };
}

export type TranscriptPreambleModel = {
  /** 合并后的系统提示词原文（多条增量按小节 last-wins）。 */
  systemPrompt?: unknown;
  /** `<pixie-context>` 契约正文。 */
  rules?: string;
  /** 上一段交接卡。 */
  recap?: PixieSegmentsRecap;
};

export type TranscriptPreamble = {
  model: TranscriptPreambleModel;
  /** 被卡片接管的行，渲染时从消息流里去掉。 */
  consumedKeys: ReadonlySet<string>;
  /** 首条用户消息的 key：它的 `@小精灵上下文` chip 归卡片管。 */
  contextRowKey?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 多次 system 落盘是增量：后面只带变化的小节，按小节合并才是"当前生效"的那份。 */
function mergeSystemPrompts(rows: readonly TranscriptRow[]): unknown {
  let merged: Record<string, unknown> = {};
  let sections: Record<string, unknown> = {};
  for (const row of rows) {
    const details = asRecord(row.event?.details);
    if (!details) continue;
    merged = { ...merged, ...details };
    const next = asRecord(details.sections);
    if (next) sections = { ...sections, ...next };
  }
  return Object.keys(sections).length > 0 ? { ...merged, sections } : merged;
}

/**
 * 从行列表里认出开场物料。返回 null 表示"不折叠，按原样渲染"——普通会话只有
 * 系统提示词时走这条路，保持既有的单行「系统提示词」行为。
 */
export function buildTranscriptPreamble(rows: readonly TranscriptRow[]): TranscriptPreamble | null {
  const systemRows = rows.filter((row) => row.event?.kind === "systemPrompt");
  const firstAssistantIndex = rows.findIndex((row) => row.role === "assistant");
  const recapRow = rows.find(
    (row, index) =>
      row.customType === PIXIE_SEGMENTS_CUSTOM_TYPE &&
      (firstAssistantIndex === -1 || index < firstAssistantIndex),
  );
  const firstUserRow = rows.find((row) => row.role === "user");
  const contextReference = firstUserRow
    ? parseUserAttachments(firstUserRow.copyText).references.find(
        (reference) => reference.kind === "pixie-context",
      )
    : undefined;

  // 两块以上才折；只有一条系统提示词时保持原来的单行样式（普通会话的常规形态）。
  // 多次 system 落盘（工具集变化会再写一条增量）也折：合并后只显示一份。
  const blocks = [systemRows.length > 0, Boolean(contextReference), Boolean(recapRow)].filter(
    Boolean,
  ).length;
  if (blocks < 2 && systemRows.length < 2) return null;

  const model: TranscriptPreambleModel = {};
  if (systemRows.length > 0) model.systemPrompt = mergeSystemPrompts(systemRows);
  if (contextReference) model.rules = contextReference.body;
  if (recapRow) model.recap = parsePixieSegmentsRecap(recapRow.copyText);

  const consumedKeys = new Set<string>();
  for (const row of systemRows) consumedKeys.add(row.key);
  if (recapRow) consumedKeys.add(recapRow.key);

  return {
    model,
    consumedKeys,
    ...(contextReference && firstUserRow ? { contextRowKey: firstUserRow.key } : {}),
  };
}
