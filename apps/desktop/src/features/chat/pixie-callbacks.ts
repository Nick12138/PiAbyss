/**
 * 委派信封（`<pixie-*>` 回调）的文案与摘要规则。
 *
 * 信封正文是写给模型看的指令（"请把进度转述给用户…"），卡片只取第一行当
 * 一行摘要；追问信封优先取「问题：」那一行，因为那才是用户要看的重点。
 */
import type { Translate } from "../../lib/i18n/use-t";

export type PixieCallbackVariant =
  | "ask"
  | "error"
  | "stopped"
  | "progress"
  | "report"
  | "reply"
  | "interject"
  | "dispatch"
  | "resume";

/** 信封种类 → 卡片标题。未知种类走通用文案，不抛错。 */
export function pixieCallbackLabel(variant: string | undefined, t: Translate): string {
  switch (variant) {
    case "ask":
      return t("pixieCallbackAsk");
    case "error":
      return t("pixieCallbackError");
    case "stopped":
      return t("pixieCallbackStopped");
    case "progress":
      return t("pixieCallbackProgress");
    case "report":
      return t("pixieCallbackReport");
    case "reply":
      return t("pixieCallbackReply");
    case "interject":
      return t("pixieCallbackInterject");
    case "dispatch":
      return t("pixieCallbackDispatch");
    case "resume":
      return t("pixieCallbackResume");
    default:
      return t("pixieCallback");
  }
}

function nonEmptyLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 卡片收起时的一行摘要：优先取最有信息量的那行，压掉前缀和多余空白。 */
export function pixieCallbackSummary(body: string, variant: string | undefined): string {
  const lines = nonEmptyLines(body);
  let text = "";
  if (variant === "ask") text = lines.find((line) => /^问题[：:]/.test(line)) ?? "";
  // 报错信封的抬头只写了「第 N 次失败」，真正值得一眼看到的是原始错误。
  if (!text && variant === "error") {
    text = lines.find((line) => /^原始错误[：:]/.test(line)) ?? "";
  }
  if (!text) {
    // 信封的第一行大多是以冒号结尾的抬头（「被委派会话…：」/「用户对上述问题的
    // 答复：」/「这条任务来自…」），真正的内容在下一行。
    const first = lines[0] ?? "";
    text = /[：:]\s*$/.test(first) && lines.length > 1 ? (lines[1] ?? first) : first;
  }
  text = text
    .replace(/^(问题|原始错误|错误类型)[：:]\s*/, "")
    .replace(/[：:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
