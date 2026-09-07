/**
 * Cross-process credential serialization.
 *
 * The in-process promise chain cannot prove anything here: these tests run the
 * store in separate Node processes, so only the `proper-lockfile` advisory lock
 * around the read-modify-write can prevent lost updates. That is the case that
 * matters in production, where PiAbyss and the Pi CLI share `~/.pi/agent`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// A file URL, not a bare path: `D:\...` is not a valid ESM specifier.
const storeModule = pathToFileURL(join(here, "credential-store.ts")).href;

/**
 * Run children through `node --import tsx` rather than the `.bin/tsx` shim.
 * On Windows that shim is a `.CMD` file, which `spawn` cannot execute without a
 * shell; this is the same launch shape the Host integration test uses.
 * `--import` resolves against the working directory, which vitest sets to the
 * package root, so tsx is found there.
 */
const childArgv = (scriptPath: string, args: string[]): string[] => [
  "--import",
  "tsx",
  scriptPath,
  ...args,
];

let root: string;
let authPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "piabyss-cred-proc-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  authPath = join(root, "agent", "auth.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeChildScript(body: string): string {
  // `.mts` so tsx treats the script as ESM: the temp directory has no
  // package.json, and the CJS default rejects top-level await.
  const scriptPath = join(root, `child-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(
    scriptPath,
    `import { FileCredentialStore } from ${JSON.stringify(storeModule)};\n${body}\n`,
    "utf8",
  );
  return scriptPath;
}

/**
 * tsx runs the script in a grandchild process, so signalling the immediate
 * child would leave the lock holder alive. Spawn detached and signal the whole
 * process group instead.
 */
function spawnDetachedChild(scriptPath: string, args: string[]) {
  return spawn(process.execPath, childArgv(scriptPath, args), {
    stdio: ["ignore", "ignore", "ignore"],
    // Windows has no process groups to signal; kill the child directly there.
    detached: process.platform !== "win32",
  });
}

async function killGroup(child: ReturnType<typeof spawnDetachedChild>): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
  await exited;
}

/**
 * Wait until a child signals it is actually inside the critical section.
 *
 * A fixed sleep is not enough: cold-starting node plus tsx can exceed a second
 * on a slow CI runner, and the parent would then probe a lock nobody holds.
 */
async function waitForMarker(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`child never signalled ${path}`);
}

function runChild(scriptPath: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgv(scriptPath, args), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe("FileCredentialStore across processes", () => {
  it("does not lose updates when independent processes increment the same provider", async () => {
    writeFileSync(authPath, JSON.stringify({ counter: { type: "api_key", key: "0" } }), "utf8");

    const script = writeChildScript(`
const [authPath, iterations] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
for (let i = 0; i < Number(iterations); i += 1) {
  await store.modify("counter", async (current) => {
    const value = Number(current?.key ?? "0");
    // Widen the window between read and write so an unlocked implementation
    // would reliably lose increments.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { type: "api_key", key: String(value + 1) };
  });
}
`);

    const iterations = 5;
    const children = 3;
    const results = await Promise.all(
      Array.from({ length: children }, () => runChild(script, [authPath, String(iterations)])),
    );

    for (const result of results) {
      expect(result.stderr, result.stderr).not.toContain("Error");
      expect(result.code).toBe(0);
    }

    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    expect(stored.counter.key).toBe(String(children * iterations));
  }, 60_000);

  it("rotates an expired oauth credential exactly once across racing processes", async () => {
    // Both children run pi-ai's resolveStoredOAuth callback shape: re-check
    // expiry under the lock, refresh only if still expired. The lock must
    // serialize them so the loser observes the winner's rotation and skips —
    // a double rotation would invalidate the winner's refresh token upstream,
    // and a lost update is the §11 stop condition.
    writeFileSync(
      authPath,
      JSON.stringify({ tokens: { type: "oauth", refresh: "r1", access: "a1", expires: 1 } }),
      "utf8",
    );

    const script = writeChildScript(`
import { writeFileSync } from "node:fs";
const [authPath, markerDir] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
await store.modify("tokens", async (current) => {
  if (current?.type !== "oauth") return undefined;
  if (Date.now() < current.expires) return undefined;
  // Refresh actually ran: record which process rotated.
  writeFileSync(\`\${markerDir}/refreshed-\${process.pid}\`, "1");
  return {
    type: "oauth",
    refresh: \`r2-\${process.pid}\`,
    access: \`a2-\${process.pid}\`,
    expires: 4102444800000,
  };
});
`);

    const markerDir = join(root, "markers");
    mkdirSync(markerDir, { recursive: true });
    const results = await Promise.all([
      runChild(script, [authPath, markerDir]),
      runChild(script, [authPath, markerDir]),
    ]);
    for (const result of results) {
      expect(result.stderr, result.stderr).not.toContain("Error");
      expect(result.code).toBe(0);
    }

    const markers = readdirSync(markerDir);
    expect(markers).toHaveLength(1);
    const winnerPid = markers[0]!.replace("refreshed-", "");

    const stored = JSON.parse(readFileSync(authPath, "utf8")).tokens;
    expect(stored).toEqual({
      type: "oauth",
      refresh: `r2-${winnerPid}`,
      access: `a2-${winnerPid}`,
      expires: 4102444800000,
    });
  }, 60_000);

  it("keeps auth.json parseable when a process is killed mid-write", async () => {
    writeFileSync(authPath, JSON.stringify({ p: { type: "api_key", key: "original" } }), "utf8");

    const marker = join(root, "holding-lock");
    const script = writeChildScript(`
import { writeFileSync } from "node:fs";
const [authPath, marker] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
await store.modify("p", async () => {
  writeFileSync(marker, "1");
  // Hold the lock open until the parent kills this process.
  await new Promise(() => {});
  return undefined;
});
`);

    const child = spawnDetachedChild(script, [authPath, marker]);
    await waitForMarker(marker);
    await killGroup(child);

    // The interrupted process never reached a write, and an atomic rename means
    // a reader can never observe a half-written file.
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      p: { type: "api_key", key: "original" },
    });

    // The abandoned lock must not wedge the file forever. proper-lockfile
    // clamps `stale` to a floor, so allow a retry budget that outlasts it.
    const { FileCredentialStore } = await import("./credential-store.js");
    const store = new FileCredentialStore(authPath, {
      staleMs: 5_000,
      retries: 10,
      minTimeoutMs: 200,
      maxTimeoutMs: 3_000,
    });
    await store.modify("p", async () => ({ type: "api_key", key: "recovered" }));
    expect(await store.read("p")).toEqual({ type: "api_key", key: "recovered" });
  }, 60_000);

  it("reports a typed lock_timeout instead of waiting indefinitely", async () => {
    writeFileSync(authPath, JSON.stringify({ p: { type: "api_key", key: "held" } }), "utf8");

    const marker = join(root, "holding-lock");
    const script = writeChildScript(`
import { writeFileSync } from "node:fs";
const [authPath, marker] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
await store.modify("p", async () => {
  writeFileSync(marker, "1");
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  return undefined;
});
`);

    const child = spawnDetachedChild(script, [authPath, marker]);
    try {
      // Probe only once the child is provably inside modify(); a fixed sleep
      // raced cold node+tsx startup on the slower CI lane and probed a lock
      // nobody held yet.
      await waitForMarker(marker);

      const { CredentialStoreError, FileCredentialStore } = await import("./credential-store.js");
      const impatient = new FileCredentialStore(authPath, {
        retries: 2,
        minTimeoutMs: 20,
        maxTimeoutMs: 60,
        staleMs: 30_000,
      });

      const started = Date.now();
      const error = await impatient
        .modify("p", async () => ({ type: "api_key", key: "should not land" }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as InstanceType<typeof CredentialStoreError>).code).toBe("lock_timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(JSON.parse(readFileSync(authPath, "utf8")).p.key).toBe("held");
    } finally {
      await killGroup(child);
    }
  }, 60_000);
});
