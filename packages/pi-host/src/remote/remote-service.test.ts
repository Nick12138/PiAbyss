import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { connectorBinaryPath, type CommandResult } from "./remote-installer.js";
import { RemoteService } from "./remote-service.js";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PLATFORM = "linux" as const;

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function failed(stderr = "nope"): CommandResult {
  return { code: 1, stdout: "", stderr };
}

type FakeEnvironment = {
  toolDir: string;
  pythonInstalled: boolean;
  runs: string[];
  failInstallOnce?: boolean;
};

function fakeRunner(environment: FakeEnvironment, binaryPath: string) {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    environment.runs.push([command, ...args].join(" "));
    if (args[0] === "--version") return ok("uv 0.9.0\n");
    if (args[0] === "python" && args[1] === "find") {
      return environment.pythonInstalled
        ? ok("/managed/python/3.12/bin/python3\n")
        : failed("not found");
    }
    if (args[0] === "python" && args[1] === "install") {
      environment.pythonInstalled = true;
      return ok();
    }
    if (args[0] === "tool" && args[1] === "install") {
      if (environment.failInstallOnce) {
        environment.failInstallOnce = false;
        return failed("network unreachable");
      }
      mkdirSync(dirname(binaryPath), { recursive: true });
      writeFileSync(binaryPath, "#!/bin/sh\n");
      return ok();
    }
    if (args[0] === "tool" && args[1] === "dir") return ok(`${environment.toolDir}\n`);
    if (args[0] === "tool" && args[1] === "list") {
      return ok("anywhere-cli v2.1.0\n- anywhere-cli\n");
    }
    if (args[0] === "tool" && args[1] === "uninstall") {
      rmSync(binaryPath, { force: true });
      return ok();
    }
    if (args[0] === "python" && args[1] === "uninstall") return ok();
    return ok();
  };
}

async function makeService(options: {
  failInstallOnce?: boolean;
  alive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}) {
  const agentDir = await tempDir("piabyss-remote-agent-");
  const dataDir = await tempDir("piabyss-remote-data-");
  const toolDir = await tempDir("piabyss-uv-tools-");
  const environment: FakeEnvironment = {
    toolDir,
    pythonInstalled: false,
    runs: [],
    ...(options.failInstallOnce === undefined ? {} : { failInstallOnce: options.failInstallOnce }),
  };
  const binary = connectorBinaryPath(toolDir, PLATFORM);
  const service = new RemoteService({
    agentDir,
    dataDir,
    platform: PLATFORM,
    arch: "x64",
    run: fakeRunner(environment, binary),
    download: async () => Buffer.from(""),
    fetchImpl: options.fetchImpl ?? (async () => new Response("{}", { status: 200 })),
    isAlive: async (pid) => options.alive?.(pid) ?? false,
  });
  return { service, environment, agentDir, dataDir, toolDir };
}

describe("RemoteService status", () => {
  it("starts idle, disabled and without any AA state", async () => {
    const { service } = await makeService({});
    const status = await service.status();
    expect(status.stage).toBe("idle");
    expect(status.settings.enabled).toBe(false);
    expect(status.connector.state).toBe("unconfigured");
    expect(status.runtime).toBe("missing");
    expect(status.activeServerOrigin).toBe("https://web.agents-anywhere.com");
    expect(status.steps.map((step) => step.id)).toEqual(["uv", "python", "connector", "verify"]);
    expect(status.logTail).toEqual([]);
  });

  it("reports ready when the installed connector contains the pi runtime", async () => {
    const { service, agentDir } = await makeService({});
    mkdirSync(
      join(
        agentDir,
        "piabyss",
        "remote",
        "tools",
        "anywhere-cli",
        "lib",
        "python3.12",
        "site-packages",
        "connector",
        "runtimes",
        "pi",
      ),
      { recursive: true },
    );
    expect((await service.status()).runtime).toBe("ready");
  });

  it("reports install when the configured source contains the pi runtime", async () => {
    const { service } = await makeService({});
    const source = await tempDir("pi-source-");
    mkdirSync(join(source, "connector", "runtimes", "pi"), { recursive: true });
    await service.configure({ connectorSource: source });
    expect((await service.status()).runtime).toBe("install");
  });

  it("reports a foreign connector without taking it over", async () => {
    const { service, dataDir } = await makeService({ alive: (pid) => pid === 4242 });
    await writeFile(
      join(dataDir, "connector.json"),
      JSON.stringify({
        serverUrl: "https://aa.example.com",
        connectorId: "conn_9",
        connectorToken: "secret",
      }),
      "utf8",
    );
    await writeFile(
      join(dataDir, "connector-runtime.json"),
      JSON.stringify({
        version: 2,
        runtime: { pid: 4242, kind: "desktop", connectorId: "conn_9" },
      }),
      "utf8",
    );
    const status = await service.status();
    expect(status.connector.state).toBe("foreign");
    expect(status.connector.pid).toBe(4242);
    expect(status.connector.source).toBe("desktop");
    expect(JSON.stringify(status)).not.toContain("secret");
    await expect(service.setConnectorRunning(true)).rejects.toThrow(/其他程序/);
    await expect(service.setConnectorRunning(false)).rejects.toThrow(/其他程序/);
  });
});

describe("RemoteService install", () => {
  it("walks the steps and ends installed", async () => {
    const { service, environment } = await makeService({});
    const started = await service.install();
    expect(started.stage).toBe("installing");
    expect(started.settings.enabled).toBe(true);
    await service.waitForInstall();
    const status = await service.status();
    expect(status.stage).toBe("installed");
    expect(status.versions.connector).toBe("2.1.0");
    expect(status.versions.python).toBe("3.12");
    expect(status.steps.every((step) => step.state === "done")).toBe(true);
    expect(environment.runs.some((line) => line.includes("tool install"))).toBe(true);
    expect(status.logTail.some((line) => line.includes("install finished"))).toBe(true);
  });

  it("reports a failed step and can retry", async () => {
    const { service, environment } = await makeService({ failInstallOnce: true });
    await service.install();
    await service.waitForInstall();
    const failed = await service.status();
    expect(failed.stage).toBe("failed");
    expect(failed.error).toContain("network unreachable");
    expect(failed.steps.find((step) => step.id === "connector")?.state).toBe("failed");

    await service.install();
    await service.waitForInstall();
    const retried = await service.status();
    expect(retried.stage).toBe("installed");
    expect(retried.error).toBeNull();
    expect(environment.pythonInstalled).toBe(true);
  });

  it("uninstalls without deleting the AA account data", async () => {
    const { service, dataDir, agentDir } = await makeService({});
    await writeFile(
      join(dataDir, "connector.json"),
      JSON.stringify({ connectorId: "keep-me" }),
      "utf8",
    );
    await service.install();
    await service.waitForInstall();
    const uninstalled = await service.uninstall();
    expect(uninstalled.stage).toBe("idle");
    expect(uninstalled.settings.enabled).toBe(false);
    expect(await readFile(join(dataDir, "connector.json"), "utf8")).toContain("keep-me");
    // settings.json 保留，依赖目录清空。
    const settings = await readFile(join(agentDir, "piabyss", "remote", "settings.json"), "utf8");
    expect(settings).toContain("connectorSource");
  });
});

describe("RemoteService configure", () => {
  it("normalizes and persists the server address", async () => {
    const { service } = await makeService({});
    const status = await service.configure({ serverUrl: "aa.example.com/api/v2/" });
    expect(status.settings.serverUrl).toBe("https://aa.example.com");
    expect(status.activeServerOrigin).toBe("https://aa.example.com");
  });

  it("rejects an unsupported scheme", async () => {
    const { service } = await makeService({});
    await expect(service.configure({ serverUrl: "ftp://aa.example.com" })).rejects.toThrow();
  });
});

describe("RemoteService pairing", () => {
  it("claims a pairing code, writes the connector config and keeps the token local", async () => {
    let pollCount = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/pairing/start")) {
        return new Response(
          JSON.stringify({
            pairingId: "pair_1",
            code: "ABC123",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200 },
        );
      }
      pollCount += 1;
      return new Response(
        JSON.stringify(
          pollCount === 1
            ? { status: "pending" }
            : {
                status: "claimed",
                config: {
                  serverUrl: "https://aa.example.com",
                  connectorId: "conn_1",
                  connectorToken: "cxt_secret",
                },
              },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { service, dataDir } = await makeService({ fetchImpl });
    const start = await service.pairStart();
    expect(start).toMatchObject({
      pairingId: "pair_1",
      code: "ABC123",
      webUrl: "https://web.agents-anywhere.com",
    });

    const pending = await service.pairPoll("pair_1");
    expect(pending.state).toBe("pending");
    const claimed = await service.pairPoll("pair_1");
    expect(claimed.state).toBe("claimed");

    const config = JSON.parse(await readFile(join(dataDir, "connector.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config).toMatchObject({
      serverUrl: "https://aa.example.com",
      connectorId: "conn_1",
      connectorToken: "cxt_secret",
      heartbeatSeconds: 20,
    });

    const status = await service.status();
    expect(status.connector.configured).toBe(true);
    expect(status.connector.connectorId).toBe("conn_1");
    expect(JSON.stringify(status)).not.toContain("cxt_secret");
  });

  it("reports a failed pairing poll as still pending", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/pairing/start")) {
        return new Response(JSON.stringify({ pairingId: "pair_2", code: "XYZ789" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ detail: "temporarily unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;
    const { service } = await makeService({ fetchImpl });
    await service.pairStart();
    const result = await service.pairPoll("pair_2");
    expect(result.state).toBe("pending");
    expect(result.detail).toContain("temporarily unavailable");
  });

  it("refuses to overwrite credentials while another connector owns the device", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/pairing/start")) {
        return new Response(JSON.stringify({ pairingId: "pair_3", code: "ABC999" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          status: "claimed",
          config: {
            serverUrl: "https://aa.example.com",
            connectorId: "conn_x",
            connectorToken: "cxt_x",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { service, dataDir } = await makeService({
      fetchImpl,
      alive: (pid) => pid === 7777,
    });
    await writeFile(
      join(dataDir, "connector-runtime.json"),
      JSON.stringify({ version: 2, runtime: { pid: 7777, kind: "desktop" } }),
      "utf8",
    );
    await service.pairStart();
    const result = await service.pairPoll("pair_3");
    expect(result.state).toBe("failed");
    expect(result.detail).toContain("其他程序");
    await expect(readFile(join(dataDir, "connector.json"), "utf8")).rejects.toThrow();
  });

  it("rejects an unknown pairing id", async () => {
    const { service } = await makeService({});
    expect(await service.pairPoll("missing")).toMatchObject({ state: "failed" });
  });
});
