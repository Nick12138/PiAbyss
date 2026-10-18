import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { automationApi, automationApiToken, automationRoot } from "./automation-api.js";

let server: http.Server;
let port: number;
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            root: "C:/tmp/automation",
            port,
            activeJobs: ["a1b2c3d4"],
            tickMs: 30000,
            maxConcurrent: 2,
          }),
        );
        return;
      }
      if (req.url === "/api/echo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echoed: JSON.parse(body || "{}") }));
        return;
      }
      if (req.url?.startsWith("/api/conflict")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "任务正在执行中" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未知接口" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  process.env.PI_AUTOMATION_PORT = String(port);
  process.env.PI_AUTOMATION_TOKEN = "test-token";
});

afterAll(() => {
  server.close();
  delete process.env.PI_AUTOMATION_PORT;
  delete process.env.PI_AUTOMATION_TOKEN;
});

describe("automationApi", () => {
  it("parses a JSON payload and sends the auth header", async () => {
    const outcome = await automationApi<{ ok: boolean }>("/api/health", "GET");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.ok).toBe(true);
      expect(outcome.status).toBe(200);
    }
    expect(lastHeaders["x-pi-automation-token"]).toBe("test-token");
  });

  it("sends a JSON body with content-type for writes", async () => {
    const outcome = await automationApi<{ echoed: { a: number } }>("/api/echo", "POST", {
      body: { a: 1 },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.echoed.a).toBe(1);
    expect(lastHeaders["content-type"]).toContain("application/json");
  });

  it("returns non-2xx payloads with their status", async () => {
    const outcome = await automationApi<{ error: string }>("/api/conflict", "POST", { body: {} });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.error).toContain("正在执行中");
    }
  });

  it("maps connection failures to status:null", async () => {
    process.env.PI_AUTOMATION_PORT = "1"; // nothing listens here
    const outcome = await automationApi("/api/health", "GET");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBeNull();
    process.env.PI_AUTOMATION_PORT = String(port);
  });
});

describe("automationApi without a local token", () => {
  let savedToken: string | undefined;
  let savedDir: string | undefined;

  beforeAll(() => {
    savedToken = process.env.PI_AUTOMATION_TOKEN;
    savedDir = process.env.PI_AUTOMATION_DIR;
    delete process.env.PI_AUTOMATION_TOKEN;
    process.env.PI_AUTOMATION_DIR = "/piabyss-automation-store-that-does-not-exist";
  });

  afterAll(() => {
    if (savedToken !== undefined) process.env.PI_AUTOMATION_TOKEN = savedToken;
    if (savedDir !== undefined) process.env.PI_AUTOMATION_DIR = savedDir;
    else delete process.env.PI_AUTOMATION_DIR;
  });

  it("answers authed requests locally instead of sending them", async () => {
    lastHeaders = {};
    const outcome = await automationApi<{ echoed: unknown }>("/api/echo", "POST", {
      body: { a: 1 },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(401);
      // 说清是 Host 没 token，而不是让控制面的「缺少或错误的 token」背锅
      expect(outcome.error).toContain("本地未取到控制面 token");
    }
    expect(lastHeaders).toEqual({});
  });

  it("still probes health, which needs no token", async () => {
    const outcome = await automationApi<{ ok: boolean }>("/api/health", "GET");
    expect(outcome.ok).toBe(true);
  });
});

describe("automationApiToken", () => {
  it("prefers the env token", () => {
    expect(automationApiToken()).toBe("test-token");
  });
});

// 更名前的部署只会写 PI_SCHEDULE_*；Host 必须继续认，且新名优先——否则两边算出
// 不同的数据根，表现是每次调用都 401，而不是一句「环境变量没改名」。
describe("pre-rename env aliases", () => {
  const NAMES = [
    "PI_AUTOMATION_DIR",
    "PI_SCHEDULE_DIR",
    "PI_AUTOMATION_PORT",
    "PI_SCHEDULE_PORT",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeAll(() => {
    saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  });

  afterAll(() => {
    for (const name of NAMES) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("still honors PI_SCHEDULE_DIR when the new name is absent", () => {
    delete process.env.PI_AUTOMATION_DIR;
    process.env.PI_SCHEDULE_DIR = "/piabyss-legacy-store";
    expect(automationRoot()).toBe("/piabyss-legacy-store");
  });

  it("prefers PI_AUTOMATION_DIR when both are set", () => {
    process.env.PI_SCHEDULE_DIR = "/piabyss-legacy-store";
    process.env.PI_AUTOMATION_DIR = "/piabyss-current-store";
    expect(automationRoot()).toBe("/piabyss-current-store");
  });

  it("reads the port from the old spelling when the new one is absent", async () => {
    delete process.env.PI_AUTOMATION_PORT;
    process.env.PI_SCHEDULE_PORT = String(port);
    const viaLegacy = await automationApi<{ ok: boolean }>("/api/health", "GET");
    expect(viaLegacy.ok).toBe(true);

    // 旧名指向没人监听的端口 → 连不上，说明它确实是被读的那个值而不是巧合
    process.env.PI_SCHEDULE_PORT = "1";
    const unreachable = await automationApi("/api/health", "GET");
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) expect(unreachable.status).toBeNull();

    process.env.PI_AUTOMATION_PORT = String(port);
    delete process.env.PI_SCHEDULE_PORT;
  });
});
