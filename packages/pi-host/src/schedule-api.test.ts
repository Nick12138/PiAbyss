import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { scheduleApi, scheduleApiToken } from "./schedule-api.js";

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
            root: "C:/tmp/schedule",
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
  process.env.PI_SCHEDULE_PORT = String(port);
  process.env.PI_SCHEDULE_TOKEN = "test-token";
});

afterAll(() => {
  server.close();
  delete process.env.PI_SCHEDULE_PORT;
  delete process.env.PI_SCHEDULE_TOKEN;
});

describe("scheduleApi", () => {
  it("parses a JSON payload and sends the auth header", async () => {
    const outcome = await scheduleApi<{ ok: boolean }>("/api/health", "GET");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.ok).toBe(true);
      expect(outcome.status).toBe(200);
    }
    expect(lastHeaders["x-pi-schedule-token"]).toBe("test-token");
  });

  it("sends a JSON body with content-type for writes", async () => {
    const outcome = await scheduleApi<{ echoed: { a: number } }>("/api/echo", "POST", {
      body: { a: 1 },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.echoed.a).toBe(1);
    expect(lastHeaders["content-type"]).toContain("application/json");
  });

  it("returns non-2xx payloads with their status", async () => {
    const outcome = await scheduleApi<{ error: string }>("/api/conflict", "POST", { body: {} });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.error).toContain("正在执行中");
    }
  });

  it("maps connection failures to status:null", async () => {
    process.env.PI_SCHEDULE_PORT = "1"; // nothing listens here
    const outcome = await scheduleApi("/api/health", "GET");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBeNull();
    process.env.PI_SCHEDULE_PORT = String(port);
  });
});

describe("scheduleApiToken", () => {
  it("prefers the env token", () => {
    expect(scheduleApiToken()).toBe("test-token");
  });
});
