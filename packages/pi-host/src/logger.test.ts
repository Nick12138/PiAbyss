import { describe, expect, it } from "vitest";
import { log } from "./logger.js";

type CapturedLogEntry = {
  message: string;
  meta?: unknown;
};

function captureEntry(run: () => void): CapturedLogEntry {
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  expect(captured).toHaveLength(1);
  return JSON.parse(captured[0]!) as CapturedLogEntry;
}

describe("structured logger redaction", () => {
  it("redacts secret-shaped values without corrupting the JSON log entry", () => {
    let entry: CapturedLogEntry | undefined;

    expect(() => {
      entry = captureEntry(() =>
        log("error", "Provider rejected sk-message-secret", {
          message: "invalid token",
          detail: "sk-structured-secret",
        }),
      );
    }).not.toThrow();

    expect(entry?.message).toBe("Provider rejected [REDACTED]");
    expect(entry?.meta).toEqual({
      message: "invalid token",
      detail: "[REDACTED]",
    });
  });

  it("redacts labeled and authorization secrets in plain messages", () => {
    const entry = captureEntry(() =>
      log(
        "warn",
        "token=plain-token clientSecret='plain secret' authorization: Basic dXNlcjpwYXNz",
      ),
    );

    expect(entry.message).toBe("token=[REDACTED] clientSecret=[REDACTED] authorization=[REDACTED]");
  });

  it("redacts sensitive keys recursively without mutating the caller", () => {
    const meta = {
      apiKey: "ordinary-api-key-value",
      nested: {
        authorization: "Basic credentials",
        password: "hunter2",
        clientSecret: "ordinary-client-secret",
        tokenCount: 42,
      },
      items: [{ refreshToken: "ordinary-refresh-token" }],
      safe: "visible",
    };

    const entry = captureEntry(() => log("info", "Provider metadata", meta));

    expect(entry.meta).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        password: "[REDACTED]",
        clientSecret: "[REDACTED]",
        tokenCount: 42,
      },
      items: [{ refreshToken: "[REDACTED]" }],
      safe: "visible",
    });
    expect(meta.apiKey).toBe("ordinary-api-key-value");
    expect(meta.nested.clientSecret).toBe("ordinary-client-secret");
  });

  it("normalizes circular and non-JSON metadata without throwing", () => {
    const meta: Record<string, unknown> = { count: 3n };
    meta.self = meta;

    const entry = captureEntry(() => log("warn", "Cyclic metadata", meta));

    expect(entry.meta).toEqual({ count: "3", self: "[Circular]" });
  });

  it("falls back to a safe placeholder when metadata access throws", () => {
    const meta: Record<string, unknown> = {};
    Object.defineProperty(meta, "detail", {
      enumerable: true,
      get() {
        throw new Error("sk-getter-secret");
      },
    });

    let entry: CapturedLogEntry | undefined;
    expect(() => {
      entry = captureEntry(() => log("error", "Could not inspect metadata", meta));
    }).not.toThrow();

    expect(entry?.meta).toBe("[UNSERIALIZABLE]");
  });
});

describe("package-name redaction", () => {
  it("keeps scoped package names readable in log meta", () => {
    // Regression: `npm:@scope/some-package` contains a `-package` run, and the
    // old token pattern (`key-` + 8 chars) matched the inner `sk-...-package`
    // substring, turning every logged package name into `[REDACTED]` and
    // making removed/installed package diagnostics unreadable.
    const entry: CapturedLogEntry = captureEntry(() =>
      log("info", "Removed superseded extension packages", {
        removed: ["npm:@juicesharp/rpiv-ask-user-question"],
      }),
    );
    expect(JSON.stringify(entry.meta)).toContain("npm:@juicesharp/rpiv-ask-user-question");
    expect(JSON.stringify(entry.meta)).not.toContain("[REDACTED]");
  });
});
