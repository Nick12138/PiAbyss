/**
 * ` ```schedule-plan ` 围栏：**草案的线格式**。
 *
 * 小精灵与智能创建会话都靠它交付一份完整计划配置（未确定的字段写 null），
 * 前端把它从对话文本里拆出来渲染成确认卡片。这个模块刻意不依赖 i18n、store、
 * React——转写投影（`chat/transcript-model`）也要用它，谁都不该为了拆一段围栏
 * 而把整条 UI 依赖链拖进对话渲染。
 */
import type { ScheduleModelRef, ScheduleTrigger } from "@piabyss/protocol";

/** Plan-config draft parsed from the assistant's ```schedule-plan block. `null` means the field was never determined. */
export type SchedulePlanDraft = {
  name?: string | null;
  kind?: "prompt" | "command" | null;
  prompt?: string | null;
  command?: string | null;
  cwd?: string | null;
  trigger?: ScheduleTrigger | null;
  permission?: string | null;
  model?: ScheduleModelRef | null;
  missedWindow?: string | null;
  timeoutMs?: number | null;
  maxRuns?: number | null;
  tags?: string[] | null;
  notify?: string | null;
  loadExtensions?: boolean | null;
  /**
   * 草案要改的那条现有计划。优化/修改路径由注入的 `<schedule-job id>` 带出，
   * 卡片据此走 update 而不是又建一条——没有它，「把日报改到 9 点」会变成重复计划。
   */
  jobId?: string | null;
};

export type SchedulePlanFence = {
  /** 解析失败为 null（原文照旧显示，别把用户和模型说的话吞进黑洞）。 */
  plan: SchedulePlanDraft | null;
  raw: string;
};

const PLAN_FENCE_MARK = "```schedule-plan";

/**
 * 确认/取消回执的 customType。卡片的四态**由会话里的回执倒推**（而不是记在
 * localStorage）：换段、重开、重启之后状态都得对，而且小精灵自己也在对话里读得到。
 */
export const PLAN_RECEIPT_CUSTOM_TYPE = "schedule-plan-receipt";

export type PlanReceipt = {
  /** 与草案块的 key 同一口径（`消息序号:第几份`），两边必须算出同一个串。 */
  planKey: string;
  action: "created" | "updated" | "cancelled";
  jobId?: string | null;
  name?: string;
};

/** 从回执 custom_message 的 details 里读回结构化结果；读不动就当没有回执。 */
export function parsePlanReceipt(details: unknown): PlanReceipt | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.planKey !== "string") return null;
  if (d.action !== "created" && d.action !== "updated" && d.action !== "cancelled") return null;
  return {
    planKey: d.planKey,
    action: d.action,
    jobId: typeof d.jobId === "string" ? d.jobId : null,
    name: typeof d.name === "string" ? d.name : undefined,
  };
}

function fenceRe(): RegExp {
  // 每次新建：带 g  flags 的正则共享 lastIndex，模块级常量会让 matchAll 之外
  // 的调用（replace）拿到上一次的位置。
  return /```schedule-plan[^\n]*\n([\s\S]*?)```/g;
}

function parsePlanFence(raw: string): SchedulePlanDraft | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SchedulePlanDraft;
    }
  } catch {
    /* 半截或畸形 JSON：交给调用方按「读不动」处理 */
  }
  return null;
}

/** 按出现顺序取出所有**已闭合**的草案围栏。 */
export function extractPlanFences(text: string): SchedulePlanFence[] {
  const out: SchedulePlanFence[] = [];
  for (const match of text.matchAll(fenceRe())) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    out.push({ plan: parsePlanFence(raw), raw });
  }
  return out;
}

/** 最后一个**已解析成功**的草案（智能创建页只看这一份；卡片要全部历史）。 */
export function latestPlanFence(text: string): SchedulePlanDraft | null {
  const fences = extractPlanFences(text);
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    if (fences[i].plan) return fences[i].plan;
  }
  return null;
}

/** 文本里是否出现过围栏（含流式写到一半、尚未闭合的那截）。 */
export function hasPlanFence(text: string): boolean {
  return text.includes(PLAN_FENCE_MARK);
}

/**
 * 一条文本按围栏切成「话 / 草案 / 话」的片段序列，顺序保持。
 * 未闭合的尾巴单独成段但**不算草案**：半截 JSON 既不该显示成配置，也不能被确认。
 */
export function splitPlanFenceSegments(
  text: string,
): Array<
  { kind: "text"; text: string } | { kind: "plan"; plan: SchedulePlanDraft | null; raw: string }
> {
  if (!hasPlanFence(text)) return [{ kind: "text", text }];
  const out: Array<
    { kind: "text"; text: string } | { kind: "plan"; plan: SchedulePlanDraft | null; raw: string }
  > = [];
  let rest = text;
  while (rest.length > 0) {
    const match = fenceRe().exec(rest);
    const open = rest.indexOf(PLAN_FENCE_MARK);
    // 先认完整围栏；没有，再认未闭合的尾巴。
    if (match && (open < 0 || match.index === open)) {
      const before = rest.slice(0, match.index).trim();
      if (before) out.push({ kind: "text", text: before });
      const raw = (match[1] ?? "").trim();
      out.push({ kind: "plan", plan: parsePlanFence(raw), raw });
      rest = rest.slice(match.index + match[0].length);
      continue;
    }
    if (open < 0) {
      out.push({ kind: "text", text: rest.trim() });
      break;
    }
    const before = rest.slice(0, open).trim();
    if (before) out.push({ kind: "text", text: before });
    // 尾巴是流式中的半截 JSON：不渲染成草案，也不显示原文糊用户一脸。
    rest = "";
  }
  return out;
}

/**
 * 剥掉围栏，只留模型给人看的话（含剪掉未闭合的尾巴）。
 * 与 `splitPlanFenceSegments(...).filter(text)` 同口径，供只要纯文本的调用方使用。
 */
export function stripPlanFences(text: string): string {
  if (!hasPlanFence(text)) return text;
  return splitPlanFenceSegments(text)
    .filter((part) => part.kind === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
