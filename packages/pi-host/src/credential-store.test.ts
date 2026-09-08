import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { CredentialStoreError, FileCredentialStore } from "./credential-store.js";
import { clearCredentialCommandCache } from "./credential-config-value.js";

let root: string;
let authPath: string;
let store: FileCredentialStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "piabyss-cred-"));
  authPath = join(root, "agent", "auth.json");
  store = new FileCredentialStore(authPath);
  clearCredentialCommandCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAuth(value: unknown): void {
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(authPath, JSON.stringify(value, null, 2), "utf8");
}

function readAuth(): Record<string, unknown> {
  return JSON.parse(readFileSync(authPath, "utf8"));
}

describe("FileCredentialStore contract", () => {
  it("returns undefined for a missing provider and a missing file", async () => {
    expect(await store.read("absent")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("reads and lists stored credentials without exposing secrets in list()", async () => {
    writeAuth({
      literal: { type: "api_key", key: "sk-literal-value" },
      tokens: { type: "oauth", refresh: "r", access: "a", expires: 42 },
    });

    expect(await store.read("literal")).toEqual({ type: "api_key", key: "sk-literal-value" });
    const infos = await store.list();
    expect(infos).toHaveLength(2);
    expect(infos).toContainEqual({ providerId: "literal", type: "api_key" });
    expect(infos).toContainEqual({ providerId: "tokens", type: "oauth" });
    expect(JSON.stringify(infos)).not.toContain("sk-literal-value");
  });

  it("persists a credential written through modify and reads it back from disk", async () => {
    const next: Credential = { type: "api_key", key: "sk-new" };
    expect(await store.modify("p", async () => next)).toEqual(next);
    expect(readAuth()).toEqual({ p: next });
    expect(await new FileCredentialStore(authPath).read("p")).toEqual(next);
  });

  it("treats an undefined modify result as unchanged, not as a delete", async () => {
    writeAuth({ p: { type: "api_key", key: "keep" } });
    const before = readFileSync(authPath, "utf8");

    const result = await store.modify("p", async () => undefined);

    expect(result).toEqual({ type: "api_key", key: "keep" });
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(await store.read("p")).toEqual({ type: "api_key", key: "keep" });
  });

  it("deletes only the named provider", async () => {
    writeAuth({
      a: { type: "api_key", key: "one" },
      b: { type: "api_key", key: "two" },
    });

    await store.delete("a");

    expect(readAuth()).toEqual({ b: { type: "api_key", key: "two" } });
    expect(await store.read("a")).toBeUndefined();
  });

  it("deleting an absent provider is a no-op", async () => {
    writeAuth({ b: { type: "api_key", key: "two" } });
    await store.delete("missing");
    expect(readAuth()).toEqual({ b: { type: "api_key", key: "two" } });
  });

  it("observes credentials written by another process between reads", async () => {
    writeAuth({ p: { type: "api_key", key: "first" } });
    expect(await store.read("p")).toEqual({ type: "api_key", key: "first" });

    writeAuth({ p: { type: "api_key", key: "rotated" } });

    expect(await store.read("p")).toEqual({ type: "api_key", key: "rotated" });
  });
});

describe("FileCredentialStore field preservation", () => {
  it("keeps unknown providers and unknown credential fields across a write", async () => {
    writeAuth({
      untouched: { type: "api_key", key: "other", futureField: { nested: true } },
      "not-a-credential": { some: "unknown shape" },
      target: { type: "api_key", key: "old", vendorExtra: "keep-me" },
    });

    await store.modify("target", async (current) => ({
      ...(current as Credential),
      key: "new",
    }));

    const written = readAuth();
    expect(written.untouched).toEqual({
      type: "api_key",
      key: "other",
      futureField: { nested: true },
    });
    expect(written["not-a-credential"]).toEqual({ some: "unknown shape" });
    expect(written.target).toEqual({ type: "api_key", key: "new", vendorExtra: "keep-me" });
  });

  it("hands modify the raw stored key so a command reference is never overwritten with its output", async () => {
    writeAuth({ p: { type: "api_key", key: "$PIABYSS_TEST_CRED" } });
    process.env.PIABYSS_TEST_CRED = "resolved-secret";
    try {
      // read() resolves for display...
      expect(await store.read("p")).toEqual({ type: "api_key", key: "resolved-secret" });

      // ...but modify() must see the reference, or spreading `current` would
      // bake the live secret into auth.json.
      let seen: Credential | undefined;
      await store.modify("p", async (current) => {
        seen = current;
        return { ...(current as Credential), env: { EXTRA: "1" } };
      });

      expect(seen).toEqual({ type: "api_key", key: "$PIABYSS_TEST_CRED" });
      expect(readAuth().p).toEqual({
        type: "api_key",
        key: "$PIABYSS_TEST_CRED",
        env: { EXTRA: "1" },
      });
      expect(readFileSync(authPath, "utf8")).not.toContain("resolved-secret");
    } finally {
      delete process.env.PIABYSS_TEST_CRED;
    }
  });
});

/**
 * The exact callback pi-ai's resolveStoredOAuth passes to modify() when a
 * request finds an expired oauth credential (auth/resolve.js, 0.82.1):
 * re-check type and expiry under the lock, refresh only if still expired.
 */
function sdkShapedRefresh(
  refresh: (current: Credential) => Promise<Credential>,
): (current: Credential | undefined) => Promise<Credential | undefined> {
  return async (current) => {
    if (current?.type !== "oauth") return undefined;
    if (Date.now() < (current as { expires: number }).expires) return undefined;
    return refresh(current);
  };
}

describe("FileCredentialStore oauth refresh (resolveStoredOAuth contract)", () => {
  const FRESH = 4102444800000; // year 2100, matching the checked-in fixture

  it("returns an oauth credential from read() untouched, extra fields included", async () => {
    const stored = {
      type: "oauth",
      refresh: "r1",
      access: "a1",
      expires: FRESH,
      enterpriseUrl: "https://example.invalid",
    };
    writeAuth({ tokens: stored });

    // Template resolution applies to api_key credentials only; an oauth
    // credential must come back byte-for-byte or the runtime would refresh
    // against a mutated token.
    expect(await store.read("tokens")).toEqual(stored);
  });

  it("persists an SDK-shaped refresh of an expired credential", async () => {
    writeAuth({ tokens: { type: "oauth", refresh: "r1", access: "a1", expires: 1 } });

    const rotated = await store.modify(
      "tokens",
      sdkShapedRefresh(async () => ({
        type: "oauth",
        refresh: "r2",
        access: "a2",
        expires: FRESH,
      })),
    );

    expect(rotated).toEqual({ type: "oauth", refresh: "r2", access: "a2", expires: FRESH });
    expect(readAuth().tokens).toEqual(rotated);
    // A restart (new store over the same file) sees the rotated token.
    expect(await new FileCredentialStore(authPath).read("tokens")).toEqual(rotated);
  });

  it("skips the refresh when the credential is fresh again under the lock", async () => {
    // Double-checked locking: a competing refresh already rotated the token,
    // so this caller's callback returns undefined and modify() must hand back
    // the current credential — not delete it, not rotate a second time.
    const current = { type: "oauth", refresh: "r2", access: "a2", expires: FRESH };
    writeAuth({ tokens: current });
    const before = readFileSync(authPath, "utf8");

    let refreshed = 0;
    const result = await store.modify(
      "tokens",
      sdkShapedRefresh(async (c) => {
        refreshed += 1;
        return c;
      }),
    );

    expect(refreshed).toBe(0);
    expect(result).toEqual(current);
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });

  it("keeps the stored token intact when the refresh callback throws", async () => {
    const stored = { type: "oauth", refresh: "r1", access: "a1", expires: 1 };
    writeAuth({ tokens: stored });

    await expect(
      store.modify(
        "tokens",
        sdkShapedRefresh(async () => {
          throw new Error("upstream 400: invalid_grant");
        }),
      ),
    ).rejects.toThrow("invalid_grant");

    // The failed refresh must not corrupt or drop the credential, and the
    // store must stay usable for the retry.
    expect(readAuth().tokens).toEqual(stored);
    expect(
      await store.modify(
        "tokens",
        sdkShapedRefresh(async () => ({
          type: "oauth",
          refresh: "r2",
          access: "a2",
          expires: FRESH,
        })),
      ),
    ).toMatchObject({ access: "a2" });
  });
});

describe("FileCredentialStore durability and permissions", () => {
  it("leaves a newly created credential file empty until the first mutation", async () => {
    const snapshot = await store.snapshot();

    expect(snapshot.content).toBe("");
    expect(readFileSync(authPath, "utf8")).toBe("");
    expect(await store.list()).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
    }

    await store.modify("p", async () => ({ type: "api_key", key: "k" }));
    expect(readAuth()).toEqual({ p: { type: "api_key", key: "k" } });
  });

  it("creates the agent directory 0700 and the credential file 0600", async () => {
    // Windows does not honour POSIX mode bits; the store's permission promise
    // is scoped to platforms that do.
    if (process.platform === "win32") return;
    await store.modify("p", async () => ({ type: "api_key", key: "k" }));

    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "agent")).mode & 0o777).toBe(0o700);
  });

  it("leaves no temp files behind after a successful write", async () => {
    await store.modify("p", async () => ({ type: "api_key", key: "k" }));
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "agent")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the original file and cleans up when the callback throws", async () => {
    writeAuth({ p: { type: "api_key", key: "original" } });
    const before = readFileSync(authPath, "utf8");

    await expect(
      store.modify("p", async () => {
        throw new Error("interrupted mid-write");
      }),
    ).rejects.toThrow("interrupted mid-write");

    expect(readFileSync(authPath, "utf8")).toBe(before);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "agent")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("releases the lock after a failed modify so the store stays usable", async () => {
    await expect(
      store.modify("p", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await store.modify("p", async () => ({ type: "api_key", key: "after" }));
    expect(await store.read("p")).toEqual({ type: "api_key", key: "after" });
  });
});

describe("FileCredentialStore typed errors", () => {
  it("reports malformed JSON as a typed error without leaking file contents", async () => {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(authPath, '{"p": {"type": "api_key", "key": "sk-secret-value"', "utf8");

    const error = await store.read("p").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe("malformed");
    expect((error as CredentialStoreError).message).not.toContain("sk-secret-value");
  });

  it("rejects a non-object auth.json", async () => {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(authPath, "[1, 2, 3]", "utf8");

    const error = await store.list().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe("malformed");
  });

  it("reports a write into an unwritable directory as a typed io error", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(authPath, "{}", "utf8");
    chmodSync(agentDir, 0o500);
    try {
      // Short retry budget: this asserts the failure shape, not the wait.
      const impatient = new FileCredentialStore(authPath, {
        retries: 1,
        minTimeoutMs: 10,
        maxTimeoutMs: 20,
      });
      const error = await impatient
        .modify("p", async () => ({ type: "api_key", key: "k" }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CredentialStoreError);
      expect(["io", "lock_timeout"]).toContain((error as CredentialStoreError).code);
    } finally {
      chmodSync(agentDir, 0o700);
    }
  });
});

describe("FileCredentialStore in-process concurrency", () => {
  it("serializes concurrent modifies so no update is lost", async () => {
    await store.modify("counter", async () => ({ type: "api_key", key: "0" }));

    await Promise.all(
      Array.from({ length: 12 }, () =>
        store.modify("counter", async (current) => {
          const value = Number((current as { key?: string } | undefined)?.key ?? "0");
          // Yield inside the critical section: a non-serialized store would
          // interleave here and lose increments.
          await new Promise((resolve) => setImmediate(resolve));
          return { type: "api_key", key: String(value + 1) };
        }),
      ),
    );

    expect(await store.read("counter")).toEqual({ type: "api_key", key: "12" });
  });

  it("serializes modify against delete", async () => {
    await store.modify("p", async () => ({ type: "api_key", key: "1" }));

    await Promise.all([
      store.modify("p", async () => ({ type: "api_key", key: "2" })),
      store.delete("p"),
    ]);

    const infos = await store.list();
    expect(infos.filter((info) => info.providerId === "p").length).toBeLessThanOrEqual(1);
    expect(() => readAuth()).not.toThrow();
  });
});

describe("FileCredentialStore logging", () => {
  it("never writes a key, token, or whole credential to stderr", async () => {
    const secrets = ["sk-super-secret-key", "refresh-token-secret", "access-token-secret"];
    writeAuth({
      p: { type: "api_key", key: secrets[0] },
      o: { type: "oauth", refresh: secrets[1], access: secrets[2], expires: 1 },
    });

    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await store.read("p");
      await store.read("o");
      await store.list();
      await store.modify("p", async () => ({ type: "api_key", key: secrets[0] }));
      await store.snapshot();
      await store.delete("o");
      await store
        .modify("p", async () => {
          throw new Error("write failed");
        })
        .catch(() => undefined);
    } finally {
      process.stderr.write = original;
    }

    const output = captured.join("");
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

describe("FileCredentialStore snapshot and restore", () => {
  it("restores the exact prior bytes, including entries added afterwards", async () => {
    writeAuth({ a: { type: "api_key", key: "one" } });
    const snapshot = await store.snapshot();

    await store.modify("b", async () => ({ type: "api_key", key: "two" }));
    expect(await store.read("b")).toBeDefined();

    await store.restore(snapshot);

    expect(readAuth()).toEqual({ a: { type: "api_key", key: "one" } });
    expect(await store.read("b")).toBeUndefined();
  });

  it("restores an empty first-run snapshot after a credential is added", async () => {
    const snapshot = await store.snapshot();
    expect(snapshot.content).toBe("");

    await store.modify("a", async () => ({ type: "api_key", key: "one" }));
    await store.restore(snapshot);

    expect(await store.list()).toEqual([]);
  });

  it("refuses a snapshot from a different auth file", async () => {
    const other = new FileCredentialStore(join(root, "other", "auth.json"));
    const snapshot = await other.snapshot();

    await expect(store.restore(snapshot)).rejects.toBeInstanceOf(CredentialStoreError);
  });
});
