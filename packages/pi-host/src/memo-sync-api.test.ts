import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchMemoSyncStatus,
  pokeMemoAutoSync,
  runMemoSyncNow,
  testMemoSyncConnection,
} from "./memo-sync-api.js";

let server: http.Server;
let port: number;
let lastHeaders: Record<string, string | string[] | undefined> = {};
/** 让 /api/sync 返回 409（未配置/同步中冲突）的开关。 */
let failSync = false;
const agentDir = mkdtempSync(join(tmpdir(), "piabyss-memo-sync-api-"));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/api/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            configured: true,
            accountId: "abc123",
            bucket: "memos",
            autoSync: true,
            hasSecrets: true,
            lastSyncAt: 1,
            lastSyncOk: true,
            lastSyncError: null,
          }),
        );
        return;
      }
      if (req.url === "/api/test") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, error: null }));
        return;
      }
      if (req.url === "/api/sync") {
        if (failSync) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "尚未配置 R2 连接信息" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            uploadedNotes: 1,
            uploadedImages: 0,
            downloadedNotes: 0,
            downloadedImages: 0,
            bytes: 42,
            at: 1,
          }),
        );
        return;
      }
      if (req.url === "/api/auto-sync") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ scheduled: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未知接口" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  process.env.PIABYSS_MEMO_SYNC_PORT = String(port);
  // token：env 优先；磁盘 token 的回退用例在下方单独覆盖。
  process.env.PIABYSS_MEMO_SYNC_TOKEN = "memo-api-test-token";
});

afterAll(() => {
  server.close();
  delete process.env.PIABYSS_MEMO_SYNC_PORT;
  delete process.env.PIABYSS_MEMO_SYNC_TOKEN;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("memo-sync-api（piabyss-memo 插件控制面代理）", () => {
  it("GET status：解析 JSON 载荷并带上鉴权头", async () => {
    const outcome = await fetchMemoSyncStatus(agentDir);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe(200);
      expect(outcome.data.configured).toBe(true);
      expect(outcome.data.autoSync).toBe(true);
      expect(outcome.data.lastSyncOk).toBe(true);
    }
    expect(lastHeaders["x-piabyss-memo-sync-token"]).toBe("memo-api-test-token");
  });

  it("POST test / sync：写请求可达并解析结果载荷", async () => {
    const test = await testMemoSyncConnection(agentDir);
    expect(test.ok).toBe(true);
    if (test.ok) expect(test.data.ok).toBe(true);
    expect(String(lastHeaders.accept)).toContain("application/json");

    const sync = await runMemoSyncNow(agentDir);
    expect(sync.ok).toBe(true);
    if (sync.ok) {
      expect(sync.data.uploadedNotes).toBe(1);
      expect(sync.data.bytes).toBe(42);
    }
  });

  it("非 2xx 响应带状态码与 error 细节返回", async () => {
    failSync = true;
    try {
      const outcome = await runMemoSyncNow(agentDir);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(409);
        expect(outcome.error).toContain("尚未配置");
      }
    } finally {
      failSync = false;
    }
  });

  it("连接失败映射为 status:null", async () => {
    process.env.PIABYSS_MEMO_SYNC_PORT = "1"; // nothing listens here
    const outcome = await fetchMemoSyncStatus(agentDir);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBeNull();
    process.env.PIABYSS_MEMO_SYNC_PORT = String(port);
  });

  it("pokeMemoAutoSync：fire-and-forget，失败不抛", async () => {
    expect(() => pokeMemoAutoSync(agentDir)).not.toThrow();
    process.env.PIABYSS_MEMO_SYNC_PORT = "1";
    expect(() => pokeMemoAutoSync(agentDir)).not.toThrow();
    process.env.PIABYSS_MEMO_SYNC_PORT = String(port);
    // 给 fire-and-forget 的请求一点时间完成，避免 afterAll 关闭服务器产生竞态。
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("token：env 优先，其次读 <agentDir>/piabyss/memo/sync-token", async () => {
    delete process.env.PIABYSS_MEMO_SYNC_TOKEN;
    const tokenDir = join(agentDir, "piabyss", "memo");
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, "sync-token"), "memo-api-file-token", "utf8");
    await fetchMemoSyncStatus(agentDir);
    expect(lastHeaders["x-piabyss-memo-sync-token"]).toBe("memo-api-file-token");
    process.env.PIABYSS_MEMO_SYNC_TOKEN = "memo-api-test-token";
  });
});
