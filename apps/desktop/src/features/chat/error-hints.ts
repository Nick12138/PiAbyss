/**
 * Friendly hints appended to raw provider error text shown in the transcript.
 *
 * Provider error strings arrive opaque — "402 status code (no body)",
 * "terminated", or an entire ALB "504 Gateway Time-out" HTML page. The raw
 * text is always preserved; the hint is appended after a blank line so the
 * user can tell what actually happened and what to do next.
 *
 * Pure string mapping only: no network calls, no behavior change. An error
 * shape that matches no rule is returned unchanged.
 *
 * Observed real-world shapes this covers (from session logs):
 *   - "402 status code (no body)"                      → 渠道欠费
 *   - "504 <html>...504 Gateway Time-out...alb..."     → 上游网关过载
 *   - "terminated"                                     → 流被中途掐断
 *   - "Connection error."                              → 连不上接口
 *   - "Stream ended without finish_reason"             → 流提前结束
 */

const STATUS_HINTS: ReadonlyArray<{ codes: readonly number[]; hint: (status: number) => string }> =
  [
    {
      codes: [402],
      hint: () => "💡 该渠道余额不足/已欠费（HTTP 402），重试无效。",
    },
    {
      codes: [401, 403],
      hint: (status) => `💡 渠道鉴权失败（HTTP ${status}）：API Key 无效或无权限。`,
    },
    {
      codes: [429],
      hint: () => "💡 渠道限流或配额耗尽（HTTP 429）。",
    },
    {
      codes: [500, 502, 503, 504, 529],
      hint: (status) => `💡 上游网关故障/过载（HTTP ${status}），非本地网络问题。`,
    },
  ];

const MESSAGE_HINTS: ReadonlyArray<{ match: RegExp; hint: string }> = [
  {
    match: /\bterminated\b|socket hang up|econnreset/i,
    hint: "💡 流式连接被中途掐断（上游超时/代理断链）。",
  },
  {
    match: /connection error|fetch failed|econnrefused|enotfound|etimedout|getaddrinfo/i,
    hint: "💡 连不上服务商接口，检查网络/代理与渠道 baseUrl。",
  },
  {
    match: /stream ended without finish_reason/i,
    hint: "💡 流未正常结束（上游提前断开），该渠道不稳定。",
  },
  {
    match: /service temporarily unavailable|temporarily unavailable/i,
    hint: "💡 服务商暂时不可用（过载/维护）。",
  },
];

/**
 * Extract a leading HTTP status code from provider error text like
 * "402 status code (no body)" or "OpenAI (504): <html>...".
 */
function extractStatusCode(text: string): number | undefined {
  const match = /\b([1-5]\d\d)\b/.exec(text);
  if (!match) return undefined;
  const code = Number.parseInt(match[1], 10);
  return Number.isFinite(code) ? code : undefined;
}

/** Returns the hint for a raw provider error string, or undefined if none applies. */
export function friendlyErrorHint(errorMessage: string | null | undefined): string | undefined {
  if (!errorMessage) return undefined;
  // User-initiated abort needs no hint.
  if (/request was aborted/i.test(errorMessage)) return undefined;

  const status = extractStatusCode(errorMessage);
  if (status !== undefined) {
    for (const rule of STATUS_HINTS) {
      if (rule.codes.includes(status)) return rule.hint(status);
    }
  }
  for (const rule of MESSAGE_HINTS) {
    if (rule.match.test(errorMessage)) return rule.hint;
  }
  return undefined;
}

/**
 * Collapse runs of identical "(request id: xxx)" suffixes to a single one.
 * Some gateways append the same request id twice when wrapping the upstream
 * error; genuinely different ids (distinct nodes on the chain) are kept.
 */
export function dedupeRequestIds(errorMessage: string): string {
  return errorMessage.replace(/((?:\(\s*request id\s*:\s*[^)]*\)\s*)+)$/i, (block) => {
    const ids = [...block.matchAll(/\(\s*request id\s*:\s*([^)]*)\)/gi)].map((m) => m[1].trim());
    const unique = [...new Set(ids)];
    return unique.map((id) => `(request id: ${id})`).join(" ");
  });
}

/**
 * Returns the original error text (with duplicated request-id suffixes
 * collapsed) and the friendly hint appended on a new paragraph, or the text
 * unchanged when no hint applies.
 */
export function withFriendlyErrorHint(errorMessage: string): string {
  const deduped = dedupeRequestIds(errorMessage);
  const hint = friendlyErrorHint(deduped);
  return hint ? `${deduped}\n\n${hint}` : deduped;
}

/**
 * Structured view of a provider error, for the transcript's compact failure
 * row: a friendly explanation first, a one-line gist of the raw payload, and
 * the full text only when it actually adds something to the gist.
 *
 * Provider payloads arrive in three shapes — a bare status string
 * ("402 status code (no body)"), an entire gateway HTML page, or a JSON error
 * object. Rendering any of them verbatim is what made failure rows a screen
 * tall, so the headline flattens all three to one line.
 */
export type ErrorMessageParts = {
  /** Friendly explanation (💡 …), or undefined when no rule matches. */
  hint?: string;
  /** Single-line gist of the raw payload, markup/JSON flattened away. */
  headline?: string;
  /** Full payload, present only when the headline dropped information. */
  raw?: string;
};

/** Roughly two lines of the collapsed row at the default conversation width. */
const HEADLINE_MAX = 150;

/**
 * The row already paints its own severity icon, so the hint's leading "💡 "
 * marker is dropped here. `friendlyErrorHint` / `withFriendlyErrorHint` keep
 * emitting it for notifications and copied text, where there is no icon.
 */
function stripErrorHintMarker(hint: string | undefined): string | undefined {
  return hint?.replace(/^\s*[\u{1F4A1}\u{26A0}\u{2139}]\s*/u, "");
}

const HTML_MARKER = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]/i;

function collapseWhitespace(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function truncate(text: string): string {
  if (text.length <= HEADLINE_MAX) return text;
  return `${text.slice(0, HEADLINE_MAX).trimEnd()}…`;
}

/** Gateway HTML pages carry their meaning in `<title>`; the rest is chrome. */
function headlineFromHtml(text: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  const body = title ?? text.replace(/<[^>]*>/g, " ");
  const gist = collapseWhitespace(body);
  if (!gist) return "";
  // Provider text usually prefixes the code ("504 <html>…"). The gateway title
  // already repeats it, so don't print "504 504 Gateway Time-out".
  const code = /^\s*([1-5]\d{2})\b/.exec(text)?.[1];
  return code && !gist.startsWith(code) ? `${code} ${gist}` : gist;
}

/** JSON error bodies: dig out the human message instead of showing braces. */
function headlineFromJson(text: string): string | undefined {
  if (!/^[{[]/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const queue: unknown[] = [parsed];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["message", "error_message", "error", "detail"] as const) {
      const value = (current as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return collapseWhitespace(value);
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return undefined;
}

/** One-line gist of a raw provider payload: HTML/JSON flattened, then clamped. */
export function errorHeadline(errorMessage: string): string {
  const text = errorMessage.trim();
  if (!text) return "";
  const gist = HTML_MARKER.test(text)
    ? headlineFromHtml(text)
    : (headlineFromJson(text) ?? collapseWhitespace(text));
  return truncate(gist);
}

/**
 * Splits a provider error into the pieces the compact failure row needs.
 * `raw` is omitted when the headline already says everything, which is what
 * keeps "402 status code (no body)" from growing a pointless expand arrow.
 */
export function describeErrorMessage(errorMessage: string | null | undefined): ErrorMessageParts {
  if (!errorMessage) return {};
  const raw = dedupeRequestIds(errorMessage).trim();
  if (!raw) return {};
  const hint = stripErrorHintMarker(friendlyErrorHint(raw));
  const headline = errorHeadline(raw);
  const addsDetail = headline !== raw && headline.length < raw.length;
  return {
    ...(hint ? { hint } : {}),
    ...(headline ? { headline } : {}),
    ...(addsDetail ? { raw } : {}),
  };
}
