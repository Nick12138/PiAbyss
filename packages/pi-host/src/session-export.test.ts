import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostError } from "@piabyss/protocol";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import { exportSession } from "./session-lifecycle.js";
import { TryMutex } from "./locks.js";
import { sessionStorageDirs } from "./session-storage.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

/**
 * `exportSession` reads real JSONL from disk and renders real HTML through the
 * SDK's unexported `export-html` subpath, so it is exercised against a temp
 * agent directory rather than a mocked factory.
 */
function writeSessionFile(agentDir: string, cwd: string, sessionId = SESSION_ID): string {
  const { activeDir } = sessionStorageDirs(agentDir, cwd);
  mkdirSync(activeDir, { recursive: true });
  const path = join(activeDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    }),
    JSON.stringify({
      id: "entry-1",
      type: "message",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "export me" }] },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function factoryFor(options: {
  agentDir: string;
  cwd: string;
  runtimeState?: "idle" | "running" | undefined;
}): WorkspaceGraphFactory {
  const graph = {
    canonicalCwd: options.cwd,
    servicesReady: true,
    sessionSnapshot: null,
  } as unknown as WorkspaceGraph;
  const serviceGraphLock = new TryMutex();
  return {
    deps: { agentDir: options.agentDir },
    graph,
    server: {
      graphOperations: {
        begin: () => ({ finish: () => undefined, signal: new AbortController().signal }),
      },
      serviceGraphLock,
    },
    canonicalizeCwd: (value: string) => value,
    sessionPathsEqual: (left: string, right: string) => left === right,
    getSessionOperationLock: () => ({ isHeld: () => false }),
    isSessionBusy: () => false,
    getSessionRuntimeInfo: () =>
      options.runtimeState ? { runtimeState: options.runtimeState, sessionRevision: 1 } : null,
    disposeBackgroundSessionRuntimeIfIdle: async () => "idle",
    invalidateRetainedWorkspaceGraph: async () => undefined,
  } as unknown as WorkspaceGraphFactory;
}

describe("exportSession", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piabyss-export-"));
    agentDir = join(root, "agent");
    cwd = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders HTML for a Session that is not the active one", async () => {
    const sessionPath = writeSessionFile(agentDir, cwd);
    const outPath = join(root, "out.html");
    const factory = factoryFor({ agentDir, cwd });

    const result = await exportSession(
      factory,
      REQUEST_ID,
      "html",
      SESSION_ID,
      sessionPath,
      outPath,
    );

    expect("error" in result).toBe(false);
    expect(existsSync(outPath)).toBe(true);
    // The transcript is embedded base64-encoded in the session-data script tag,
    // so decode it and assert the message survived the round trip.
    const html = readFileSync(outPath, "utf8");
    const encoded = /<script id="session-data"[^>]*>([A-Za-z0-9+/=]+)<\/script>/.exec(html)?.[1];
    expect(encoded).toBeTruthy();
    expect(Buffer.from(encoded ?? "", "base64").toString("utf8")).toContain("export me");
  }, 60_000);

  it("copies the canonical JSONL when the destination differs", async () => {
    const sessionPath = writeSessionFile(agentDir, cwd);
    const outPath = join(root, "copy.jsonl");
    const factory = factoryFor({ agentDir, cwd });

    const result = await exportSession(
      factory,
      REQUEST_ID,
      "jsonl",
      SESSION_ID,
      sessionPath,
      outPath,
    );

    expect(result).toEqual({ path: outPath });
    expect(readFileSync(outPath, "utf8")).toBe(readFileSync(sessionPath, "utf8"));
  });

  it("rejects an unknown or non-listed Session path", async () => {
    writeSessionFile(agentDir, cwd);
    const factory = factoryFor({ agentDir, cwd });

    const result = await exportSession(
      factory,
      REQUEST_ID,
      "html",
      SESSION_ID,
      join(root, "elsewhere.jsonl"),
      join(root, "out.html"),
    );

    expect((result as { error: HostError }).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("refuses to read a Session file that is still being appended to", async () => {
    const sessionPath = writeSessionFile(agentDir, cwd);
    const factory = factoryFor({ agentDir, cwd, runtimeState: "running" });

    const result = await exportSession(
      factory,
      REQUEST_ID,
      "jsonl",
      SESSION_ID,
      sessionPath,
      join(root, "out.jsonl"),
    );

    expect((result as { error: HostError }).error.code).toBe("AGENT_BUSY");
    expect(existsSync(join(root, "out.jsonl"))).toBe(false);
  });
});
