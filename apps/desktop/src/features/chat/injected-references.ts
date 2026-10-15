/**
 * Injected-reference model: prompts the app composes on the user's behalf
 * (memo handling, schedule smart-creation preamble, plan context, the pixie
 * segment preamble) travel in the prompt text so any model sees them verbatim,
 * but the UI must never show the raw prompt. This module folds those blocks
 * into `@`-style reference chips for the transcript and rebuilds the payload
 * for the composer.
 *
 * Pure functions only: parsing, envelope construction, and the copy-safe
 * visible-text view. Rendering lives in `InjectedReferenceChip`.
 */

/** Reference kinds the transcript knows how to label. */
export type InjectedReferenceKind =
  | "memo"
  | "memo-result"
  | "schedule-preamble"
  | "schedule-job"
  | "relay-mapping"
  | "pixie-context";

export type InjectedReference = {
  kind: InjectedReferenceKind;
  /** Chip title (memo title); empty when the block carries no title. */
  title: string;
  /** Inner text shown when the chip is expanded. */
  body: string;
  /** Full block including its tags, re-sent verbatim on retry. */
  raw: string;
};

export type ParsedInjectedText = {
  /** Visible text with every injected block removed. */
  text: string;
  references: InjectedReference[];
};

/**
 * Envelope the app wraps around one whole injected payload (reference block
 * plus its instruction). The transcript folds the envelope into a single chip
 * — without it the trailing instruction ("请处理上面引用的备忘录记录…") would
 * still leak into the bubble as plain text.
 */
const ENVELOPE_PATTERN =
  /<piabyss-ref\s+kind="([^"]*)"(?:\s+title="([^"]*)")?\s*>\s*([\s\S]*?)\s*<\/piabyss-ref>/gu;
/** Bare blocks: legacy transcripts and host-composed payloads (no envelope). */
const MEMO_PATTERN = /<piabyss-memo\s+([^>]*)>\s*([\s\S]*?)\s*<\/piabyss-memo>/gu;
const MEMO_RESULT_PATTERN =
  /<piabyss-memo-result\s+([^>]*)>\s*([\s\S]*?)\s*<\/piabyss-memo-result>/gu;
const SCHEDULE_PREAMBLE_PATTERN = /<schedule-preamble>\s*([\s\S]*?)\s*<\/schedule-preamble>/gu;
const SCHEDULE_JOB_PATTERN = /<schedule-job\s+([^>]*)>\s*([\s\S]*?)\s*<\/schedule-job>/gu;

/**
 * 小精灵会话段前导：Host 在段的首条用户消息外面包一层 `<pixie-context>` 契约正文
 * （身份、时间锚点、委派契约、已知工作区列表）。它必须原样送给模型，但用户气泡里
 * 只该看见自己说的话——和 memo / schedule 一样折成一张 chip。
 */
const PIXIE_CONTEXT_PATTERN = /<pixie-context>\s*([\s\S]*?)\s*<\/pixie-context>/gu;
/**
 * 通道标记行：`[pixie|ui]` / `[pixie|tg]` / `[pixie|system]`，Host 用来标注这条
 * 用户消息来自哪个入口，单独占一行。它是投递元数据，不该出现在气泡里。
 */
const PIXIE_MARKER_LINE = /^[ \t]*\[pixie\|[^\]\s]*\][ \t]*$/gmu;

const REFERENCE_KINDS: readonly InjectedReferenceKind[] = [
  "memo",
  "memo-result",
  "schedule-preamble",
  "schedule-job",
  "relay-mapping",
  "pixie-context",
];

function isReferenceKind(value: string): value is InjectedReferenceKind {
  return (REFERENCE_KINDS as readonly string[]).includes(value);
}

/** Escapes a title for a double-quoted attribute (single quotes are safe). */
function escapeAttribute(value: string): string {
  return value.replace(/"/g, "'").trim();
}

/**
 * Wraps an injected payload in the reference envelope. `kind` drives the chip
 * icon/label, `title` its caption; `body` is everything the model should see.
 */
export function buildInjectedReferenceEnvelope(input: {
  kind: InjectedReferenceKind;
  title?: string;
  body: string;
}): string {
  const title = escapeAttribute(input.title ?? "");
  const attributes = [`kind="${input.kind}"`, ...(title ? [`title="${title}"`] : [])].join(" ");
  return `<piabyss-ref ${attributes}>\n${input.body.trim()}\n</piabyss-ref>`;
}

/** First Markdown heading of a memo block, used when no envelope title exists. */
function memoBlockTitle(body: string): string {
  const line = body
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return (line ?? "").replace(/^#+\s*/, "").trim();
}

/**
 * Splits a raw user message into visible text plus reference chips. Envelopes
 * are matched first (and removed) so the blocks nested inside them are not
 * reported twice.
 */
export function parseInjectedReferences(raw: string): ParsedInjectedText {
  const references: InjectedReference[] = [];
  let text = raw.replace(
    ENVELOPE_PATTERN,
    (_match, kind: string, title: string | undefined, body: string) => {
      references.push({
        kind: isReferenceKind(kind) ? kind : "memo",
        title: title ?? "",
        body,
        raw: _match,
      });
      return "";
    },
  );
  text = text.replace(MEMO_PATTERN, (match, _attributes: string, body: string) => {
    references.push({ kind: "memo", title: memoBlockTitle(body), body, raw: match });
    return "";
  });
  text = text.replace(MEMO_RESULT_PATTERN, (match, _attributes: string, body: string) => {
    references.push({ kind: "memo-result", title: "", body, raw: match });
    return "";
  });
  text = text.replace(SCHEDULE_PREAMBLE_PATTERN, (match, body: string) => {
    references.push({ kind: "schedule-preamble", title: "", body, raw: match });
    return "";
  });
  text = text.replace(SCHEDULE_JOB_PATTERN, (match, _attributes: string, body: string) => {
    references.push({ kind: "schedule-job", title: "", body, raw: match });
    return "";
  });
  text = text.replace(PIXIE_CONTEXT_PATTERN, (match, body: string) => {
    references.push({ kind: "pixie-context", title: "", body, raw: match });
    return "";
  });
  // 标记行最后剥：它可能紧贴在块前面，块先被摘掉才好按整行匹配。
  text = text.replace(PIXIE_MARKER_LINE, "");
  return { text: text.replace(/^[ \t]*\n+/, "").trimEnd(), references };
}

/** Visible text only: the user's own words, with every injected block gone. */
export function stripInjectedReferences(raw: string): string {
  return parseInjectedReferences(raw).text;
}

/**
 * Rebuilds the message for a retry: reference payloads first (their original
 * position), then the user's text, then the rebuilt attachment blocks. Retry
 * must keep the injected payload or the memo/schedule turn loses its context.
 */
export function joinOutgoingParts(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part?.trimEnd() ?? "")
    .filter((part) => part.length > 0)
    .join("\n\n");
}
