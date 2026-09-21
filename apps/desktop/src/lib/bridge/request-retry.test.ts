import { describe, expect, it, vi } from "vitest";
import { requestWithRetry } from "./request-retry";

describe("requestWithRetry", () => {
  it("uses the default backoff when no custom delays are given", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await requestWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          return { ok: false as const, error: { retryable: true } };
        }
        return { ok: true as const };
      },
      (delayMs) => {
        waits.push(delayMs);
        return Promise.resolve();
      },
    );
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(waits).toEqual([80, 160]);
  });

  it("honors custom delays for callers needing a longer retry window", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await requestWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 4) {
          return { ok: false as const, error: { retryable: true } };
        }
        return { ok: true as const };
      },
      (delayMs) => {
        waits.push(delayMs);
        return Promise.resolve();
      },
      undefined,
      [400, 800, 1_600, 3_200],
    );
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(4);
    expect(waits).toEqual([400, 800, 1_600]);
  });

  it("stops after exhausting the custom delay list", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await requestWithRetry(
      async () => {
        attempts += 1;
        return { ok: false as const, error: { retryable: true } };
      },
      (delayMs) => {
        waits.push(delayMs);
        return Promise.resolve();
      },
      undefined,
      [400, 800],
    );
    expect(result).toEqual({ ok: false, error: { retryable: true } });
    expect(attempts).toBe(3);
    expect(waits).toEqual([400, 800]);
  });

  it("does not retry non-retryable errors", async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      error: { retryable: false },
    }));
    const result = await requestWithRetry(request, undefined, undefined, [400]);
    expect(result).toEqual({ ok: false, error: { retryable: false } });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
