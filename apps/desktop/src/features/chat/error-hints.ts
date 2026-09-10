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
      hint: () =>
        "💡 该渠道余额不足/已欠费（HTTP 402），重试无效。请给该渠道充值，或切换到其他渠道。",
    },
    {
      codes: [401, 403],
      hint: (status) =>
        `💡 渠道鉴权失败（HTTP ${status}）：API Key 无效或无权限，请检查该渠道的密钥配置。`,
    },
    {
      codes: [429],
      hint: () => "💡 渠道触发限流或配额耗尽（HTTP 429）：请稍候重试，或切换到其他渠道。",
    },
    {
      codes: [500, 502, 503, 504, 529],
      hint: (status) =>
        `💡 上游服务商网关故障/过载（HTTP ${status}），不是你的网络问题。稍后重试，或切换到其他渠道。`,
    },
  ];

const MESSAGE_HINTS: ReadonlyArray<{ match: RegExp; hint: string }> = [
  {
    match: /\bterminated\b|socket hang up|econnreset/i,
    hint: "💡 流式连接被中途掐断（常见于上游网关超时/代理断链，长生成时多发）。可重试；反复出现建议降低思考级别或切换渠道。",
  },
  {
    match: /connection error|fetch failed|econnrefused|enotfound|etimedout|getaddrinfo/i,
    hint: "💡 连不上服务商接口。请检查网络/代理，以及该渠道 baseUrl 是否可用（渠道宕机时也会表现为连接失败）。",
  },
  {
    match: /stream ended without finish_reason/i,
    hint: "💡 流式响应未正常结束（上游提前断开）。请重试；反复出现说明该渠道不稳定，建议切换渠道。",
  },
  {
    match: /service temporarily unavailable|temporarily unavailable/i,
    hint: "💡 服务商暂时不可用（服务端过载/维护），稍后重试或切换渠道。",
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
