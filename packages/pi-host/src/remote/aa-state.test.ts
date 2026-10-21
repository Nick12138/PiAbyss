import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aaDataDir,
  aaLogDir,
  isProcessAlive,
  readAaConnectorConfig,
  readAaRuntimeRecord,
} from "./aa-state.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "piabyss-aa-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("aaDataDir", () => {
  it("uses the AA default under the user home", () => {
    expect(aaDataDir({}, "/home/me")).toBe(join("/home/me", ".agents-anywhere"));
  });

  it("honors AGENT_CONNECTOR_DATA_DIR", () => {
    expect(aaDataDir({ AGENT_CONNECTOR_DATA_DIR: "/tmp/aa" }, "/home/me")).toBe("/tmp/aa");
  });

  it("derives the log directory from the data directory", () => {
    expect(aaLogDir("/tmp/aa")).toBe(join("/tmp/aa", "logs"));
  });
});

describe("readAaConnectorConfig", () => {
  it("returns null when the file is missing", async () => {
    const dir = await tempDir();
    expect(await readAaConnectorConfig(dir)).toBeNull();
  });

  it("reports token presence without exposing the token", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "connector.json"),
      JSON.stringify({
        serverUrl: "https://aa.example.com",
        connectorId: "conn_1",
        connectorToken: "secret-token",
      }),
      "utf8",
    );
    const config = await readAaConnectorConfig(dir);
    expect(config).toEqual({
      serverUrl: "https://aa.example.com",
      connectorId: "conn_1",
      hasToken: true,
    });
    expect(JSON.stringify(config)).not.toContain("secret-token");
  });

  it("requires both server url and connector id", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "connector.json"), JSON.stringify({ connectorId: "conn_1" }), "utf8");
    expect(await readAaConnectorConfig(dir)).toBeNull();
  });

  it("survives invalid JSON", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "connector.json"), "{oops", "utf8");
    expect(await readAaConnectorConfig(dir)).toBeNull();
  });
});

describe("readAaRuntimeRecord", () => {
  it("reads the v2 nested runtime record", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "connector-runtime.json"),
      JSON.stringify({
        version: 2,
        connectorIds: ["conn_1"],
        runtime: {
          instanceId: "inst",
          pid: 4321,
          kind: "cli",
          connectorId: "conn_1",
          serverUrl: "https://aa.example.com",
          startedAt: "2026-01-01T00:00:00Z",
        },
      }),
      "utf8",
    );
    expect(await readAaRuntimeRecord(dir)).toMatchObject({
      pid: 4321,
      kind: "cli",
      connectorId: "conn_1",
      serverUrl: "https://aa.example.com",
    });
  });

  it("reads the legacy top-level record", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "connector-runtime.json"),
      JSON.stringify({ pid: 99, kind: "desktop" }),
      "utf8",
    );
    expect(await readAaRuntimeRecord(dir)).toMatchObject({ pid: 99, kind: "desktop" });
  });

  it("rejects a record without a usable pid", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "connector-runtime.json"), JSON.stringify({ pid: 0 }), "utf8");
    expect(await readAaRuntimeRecord(dir)).toBeNull();
  });
});

describe("isProcessAlive", () => {
  it("rejects invalid pids", async () => {
    expect(await isProcessAlive(0)).toBe(false);
    expect(await isProcessAlive(-1)).toBe(false);
    expect(await isProcessAlive(1.5)).toBe(false);
  });

  it("detects the current process on POSIX", async () => {
    expect(await isProcessAlive(process.pid, { platform: "linux" })).toBe(true);
  });

  it("uses the injected Windows probe", async () => {
    expect(await isProcessAlive(1234, { platform: "win32", runTasklist: async () => true })).toBe(
      true,
    );
    expect(await isProcessAlive(1234, { platform: "win32", runTasklist: async () => false })).toBe(
      false,
    );
    expect(
      await isProcessAlive(1234, {
        platform: "win32",
        runTasklist: async () => {
          throw new Error("tasklist missing");
        },
      }),
    ).toBe(false);
  });
});
