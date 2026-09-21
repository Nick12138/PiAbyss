type RetryableResponse = { ok: true } | { ok: false; error?: { retryable?: boolean } };

const REQUEST_RETRY_DELAYS_MS = [80, 160, 240, 320] as const;

/**
 * Retry a Host request while it fails with a retryable error — typically a
 * transient SERVICE_GRAPH_BUSY collision between a read and a mutation.
 * Returns null when shouldContinue() reports the caller no longer wants the
 * result. `delays` overrides the default backoff for callers whose request
 * legitimately needs a longer retry window (e.g. workspace switches racing
 * another switch's graph build).
 */
export async function requestWithRetry<T extends RetryableResponse>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  shouldContinue: () => boolean = () => true,
  delays: readonly number[] = REQUEST_RETRY_DELAYS_MS,
): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    if (!shouldContinue()) return null;
    const response = await request();
    if (
      response.ok ||
      response.error?.retryable !== true ||
      attempt === delays.length
    ) {
      return response;
    }
    await wait(delays[attempt]!);
  }
}
