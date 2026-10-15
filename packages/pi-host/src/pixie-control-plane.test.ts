/**
 * Pixie loopback control-plane contract tests — the Host peer of the
 * my-pi-plugins `packages/pi-pixie/tests/pixie-contract.test.ts` assertions.
 *
 * The plugin's byte-level expectations:
 * - dispatch success 200 `{ ok: true, dispatchId, sessionId, sessionPath, queued }`
 *   (missing a field reads as a contract violation on the plugin side)
 * - dispatch/report/ask/rest/inject failure `{ ok: false, error }` readable
 * - dispatch-state 200 `{ armed, dispatchId, kind }`; any non-200/invalid
 *   shape is treated as not-armed by the plugin (401 included).
 * Endpoint handlers are exercised directly (no real socket needed) plus one
 * real-socket round trip through startPixieControlPlane (token enforced).
 */
import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import {
  PIXIE_ASK_PATH,
  PIXIE_DISPATCH_PATH,
  PIXIE_DISPATCH_STATE_PATH,
  PIXIE_INJECT_PATH,
  PIXIE_INTERJECT_PATH,
  PIXIE_REPORT_PATH,
  PIXIE_REST_PATH,
  PIXIE_STOP_PATH,
  PIXIE_TOKEN_HEADER,
  handlePixieControlPlaneRequest,
  parseAskBody,
  parseDispatchBody,
  parseInjectBody,
  parseInterjectBody,
  parseReportBody,
  parseRestBody,
  parseStopBody,
  startPixieControlPlane,
  type PixieControlPlaneDeps,
} from "./pixie-control-plane.js";

function deps(overrides: Partial<PixieControlPlaneDeps> = {}): PixieControlPlaneDeps {
  return {
    dispatch: async () => ({
      ok: true,
      dispatchId: "pix_1",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      queued: false,
      reused: false,
    }),
    report: async () => ({ ok: true }),
    ask: async () => ({ ok: true }),
    interject: async () => ({ ok: true }),
    stop: async () => ({ ok: true, action: "aborted" }),
    retry: async () => ({ ok: true, dispatchId: "pix_1" }),
    dispatchList: () => [],
    sessionList: () => [],
    rest: async () => ({ ok: true }),
    inject: async () => ({ ok: true, sessionId: "s1" }),
    dispatchState: () => ({ armed: false, dispatchId: null, kind: null }),
    ...overrides,
  };
}

describe("pixie control-plane endpoints", () => {
  it("POST /api/pixie/dispatch forwards the body and echoes the engine result", async () => {
    const seen: unknown[] = [];
    const d = deps({
      dispatch: async (request) => {
        seen.push(request);
        return {
          ok: true,
          dispatchId: "pix_9",
          sessionId: "s2",
          sessionPath: "p",
          queued: true,
          reused: false,
        };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_DISPATCH_PATH,
      JSON.stringify({ cwd: "D:/ws", task: "do it", newSession: true }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      dispatchId: "pix_9",
      sessionId: "s2",
      sessionPath: "p",
      queued: true,
      reused: false,
    });
    expect(seen).toEqual([{ cwd: "D:/ws", task: "do it", newSession: true }]);
  });

  it("POST /api/pixie/dispatch maps engine failure to { ok: false, error }", async () => {
    const out = await handlePixieControlPlaneRequest(
      deps({ dispatch: async () => ({ ok: false, error: "目标工作区未打开（D:/ws）。" }) }),
      "POST",
      PIXIE_DISPATCH_PATH,
      JSON.stringify({ cwd: "D:/ws", task: "do it" }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: false, error: "目标工作区未打开（D:/ws）。" });
  });

  it("POST /api/pixie/dispatch rejects malformed bodies with 400", async () => {
    for (const raw of [
      null,
      "not json",
      JSON.stringify({ task: "x" }),
      JSON.stringify({ cwd: "x" }),
    ]) {
      const out = await handlePixieControlPlaneRequest(deps(), "POST", PIXIE_DISPATCH_PATH, raw);
      expect(out.status).toBe(400);
      expect((out.body as { ok: boolean }).ok).toBe(false);
    }
  });

  it("POST /api/pixie/report forwards dispatchId/summary/success", async () => {
    const seen: Array<{ dispatchId: string; summary: string; success: boolean }> = [];
    const d = deps({
      report: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_REPORT_PATH,
      JSON.stringify({ dispatchId: "pix_1", summary: "done", success: false }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(seen).toEqual([{ dispatchId: "pix_1", summary: "done", success: false }]);
  });

  it("POST /api/pixie/report maps registry misses to { ok: false, error }", async () => {
    const out = await handlePixieControlPlaneRequest(
      deps({ report: async () => ({ ok: false, error: "委派记录不存在或已结束" }) }),
      "POST",
      PIXIE_REPORT_PATH,
      JSON.stringify({ dispatchId: "pix_x", summary: "s", success: true }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: false, error: "委派记录不存在或已结束" });
  });

  it("POST /api/pixie/ask forwards dispatchId/question/options", async () => {
    const seen: Array<{ dispatchId: string; question: string; options?: string[] }> = [];
    const d = deps({
      ask: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_ASK_PATH,
      JSON.stringify({ dispatchId: "pix_3", question: "选哪个？", options: ["A", "B"] }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(seen).toEqual([{ dispatchId: "pix_3", question: "选哪个？", options: ["A", "B"] }]);
  });

  it("POST /api/pixie/ask rejects malformed bodies with 400", async () => {
    for (const raw of [
      null,
      "not json",
      JSON.stringify({ question: "x" }),
      JSON.stringify({ dispatchId: "d" }),
      JSON.stringify({ dispatchId: "d", question: "q", options: [1, 2] }),
    ]) {
      const out = await handlePixieControlPlaneRequest(deps(), "POST", PIXIE_ASK_PATH, raw);
      expect(out.status).toBe(400);
    }
  });

  it("POST /api/pixie/rest forwards optional title/phrase/handoff", async () => {
    const seen: Array<{ phrase?: string | null; handoff?: string | null; title?: string | null }> =
      [];
    const d = deps({
      rest: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const empty = await handlePixieControlPlaneRequest(d, "POST", PIXIE_REST_PATH, null);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ ok: true });
    const full = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_REST_PATH,
      JSON.stringify({ title: "整理三站价格表", phrase: "先睡啦", handoff: "交接" }),
    );
    expect(full.status).toBe(200);
    expect(full.body).toEqual({ ok: true });
    expect(seen).toEqual([{}, { title: "整理三站价格表", phrase: "先睡啦", handoff: "交接" }]);
  });

  it("POST /api/pixie/inject forwards source/text (gateway预留)", async () => {
    const seen: Array<{ source: string; text: string }> = [];
    const d = deps({
      inject: async (args) => {
        seen.push(args);
        return { ok: true, sessionId: "s9" };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_INJECT_PATH,
      JSON.stringify({ source: "tg", text: "来自网关" }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, sessionId: "s9" });
    expect(seen).toEqual([{ source: "tg", text: "来自网关" }]);
    const bad = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_INJECT_PATH,
      JSON.stringify({ source: "sms", text: "x" }),
    );
    expect(bad.status).toBe(400);
  });

  it("POST /api/pixie/interject forwards dispatchId/text/mode/after", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const d = deps({
      interject: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_INTERJECT_PATH,
      JSON.stringify({
        dispatchId: "pix_5",
        text: "先汇报进度",
        mode: "checkpoint",
        after: "wait",
      }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(seen).toEqual([
      { dispatchId: "pix_5", text: "先汇报进度", mode: "checkpoint", after: "wait" },
    ]);
    const bad = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_INTERJECT_PATH,
      JSON.stringify({ dispatchId: "pix_5", text: "x", mode: "nonsense" }),
    );
    expect(bad.status).toBe(400);
  });

  it("POST /api/pixie/stop forwards dispatchId and echoes the receipt action", async () => {
    const seen: string[] = [];
    const d = deps({
      stop: async (args) => {
        seen.push(args.dispatchId);
        return { ok: true, action: "cancelled" };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_STOP_PATH,
      JSON.stringify({ dispatchId: "pix_6" }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, action: "cancelled" });
    expect(seen).toEqual(["pix_6"]);
  });

  it("POST /api/pixie/report forwards kind/files/pause (progress checkpoints)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const d = deps({
      report: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "POST",
      PIXIE_REPORT_PATH,
      JSON.stringify({
        dispatchId: "pix_8",
        summary: "已完成一半",
        success: true,
        kind: "progress",
        files: ["C:/out/a.md"],
        pause: true,
      }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(seen).toEqual([
      {
        dispatchId: "pix_8",
        summary: "已完成一半",
        success: true,
        kind: "progress",
        files: ["C:/out/a.md"],
        pause: true,
      },
    ]);
  });

  it("GET /api/pixie/dispatch-state returns the armed shape with dispatchId+kind", async () => {
    const d = deps({
      dispatchState: () => ({ armed: true, dispatchId: "pix_7", kind: "ask" }),
    });
    const out = await handlePixieControlPlaneRequest(
      d,
      "GET",
      `${PIXIE_DISPATCH_STATE_PATH}?sessionId=s1`,
      null,
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ armed: true, dispatchId: "pix_7", kind: "ask" });
  });

  it("GET /api/pixie/dispatch-state requires sessionId and rejects other methods", async () => {
    const missing = await handlePixieControlPlaneRequest(
      deps(),
      "GET",
      PIXIE_DISPATCH_STATE_PATH,
      null,
    );
    expect(missing.status).toBe(400);
    const wrongMethod = await handlePixieControlPlaneRequest(
      deps(),
      "POST",
      PIXIE_DISPATCH_PATH,
      "{}",
    );
    expect(wrongMethod.status).toBe(400); // malformed body beats the method check for POST-only endpoints
    const getDispatch = await handlePixieControlPlaneRequest(
      deps(),
      "GET",
      PIXIE_DISPATCH_PATH,
      null,
    );
    expect(getDispatch.status).toBe(405);
    const unknown = await handlePixieControlPlaneRequest(deps(), "GET", "/api/other", null);
    expect(unknown.status).toBe(404);
  });

  it("enforces the token on every endpoint when configured", async () => {
    const d = deps();
    const token = "secret-token";
    const headers = { [PIXIE_TOKEN_HEADER]: token };
    const denied = await handlePixieControlPlaneRequest(
      d,
      "GET",
      `${PIXIE_DISPATCH_STATE_PATH}?sessionId=s1`,
      null,
      { token, headers: {} },
    );
    expect(denied.status).toBe(401);
    const allowed = await handlePixieControlPlaneRequest(
      d,
      "GET",
      `${PIXIE_DISPATCH_STATE_PATH}?sessionId=s1`,
      null,
      { token, headers },
    );
    expect(allowed.status).toBe(200);
    // No token configured (test stub) → auth skipped.
    const open = await handlePixieControlPlaneRequest(
      d,
      "GET",
      `${PIXIE_DISPATCH_STATE_PATH}?sessionId=s1`,
      null,
    );
    expect(open.status).toBe(200);
  });

  it("handler exceptions become { ok: false } 200 responses, never crashes", async () => {
    const out = await handlePixieControlPlaneRequest(
      deps({
        dispatch: async () => {
          throw new Error("boom");
        },
      }),
      "POST",
      PIXIE_DISPATCH_PATH,
      JSON.stringify({ cwd: "c", task: "t" }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: false, error: "boom" });
  });

  it("serves the contract over a real loopback socket with token auth", async () => {
    const token = "loopback-secret";
    const plane = await startPixieControlPlane(deps(), { token });
    try {
      const send = (headers: Record<string, string>) =>
        new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          const body = JSON.stringify({ cwd: "C:/ws", task: "t" });
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: plane.port,
              method: "POST",
              path: PIXIE_DISPATCH_PATH,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                ...headers,
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () =>
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
              );
            },
          );
          req.on("error", reject);
          req.end(body);
        });
      const denied = await send({});
      expect(denied.status).toBe(401);
      const allowed = await send({ [PIXIE_TOKEN_HEADER]: token });
      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.body)).toEqual({
        ok: true,
        dispatchId: "pix_1",
        sessionId: "s1",
        sessionPath: "C:/s1.jsonl",
        queued: false,
        reused: false,
      });
    } finally {
      await plane.close();
    }
  });
});

describe("pixie control-plane body parsers", () => {
  it("parseDispatchBody keeps newSession only when present", () => {
    expect(parseDispatchBody(JSON.stringify({ cwd: "c", task: "t" }))).toEqual({
      ok: true,
      request: { cwd: "c", task: "t" },
    });
    expect(parseDispatchBody(JSON.stringify({ cwd: "c", task: "t", newSession: false }))).toEqual({
      ok: true,
      request: { cwd: "c", task: "t", newSession: false },
    });
  });

  it("parseDispatchBody 消费 taskName / sessionName：给了就 trim 透传，没给就不带键", () => {
    // 旧版插件不发这两个字段：必须原样受理，不能报错、也不能凭空造空串。
    expect(parseDispatchBody(JSON.stringify({ cwd: "c", task: "t" }))).toEqual({
      ok: true,
      request: { cwd: "c", task: "t" },
    });
    expect(
      parseDispatchBody(
        JSON.stringify({ cwd: "c", task: "t", taskName: " 跑登录测试 ", sessionName: "登录修复" }),
      ),
    ).toEqual({
      ok: true,
      request: { cwd: "c", task: "t", taskName: "跑登录测试", sessionName: "登录修复" },
    });
    // 全空白 = 未传（插件侧保证不会发，Host 再兜一层，字段缺席而不是空串）。
    expect(
      parseDispatchBody(
        JSON.stringify({ cwd: "c", task: "t", taskName: "   ", sessionName: null }),
      ),
    ).toEqual({ ok: true, request: { cwd: "c", task: "t" } });
    // 长度口径由引擎统一裁，边界这里不截。
    expect(
      parseDispatchBody(JSON.stringify({ cwd: "c", task: "t", taskName: "一".repeat(30) })),
    ).toEqual({ ok: true, request: { cwd: "c", task: "t", taskName: "一".repeat(30) } });
  });

  it("parseDispatchBody 拒绝非字符串的 taskName / sessionName", () => {
    for (const raw of [
      JSON.stringify({ cwd: "c", task: "t", taskName: 42 }),
      JSON.stringify({ cwd: "c", task: "t", sessionName: ["a"] }),
    ]) {
      const parsed = parseDispatchBody(raw);
      expect(parsed.ok).toBe(false);
    }
  });

  it("parseReportBody defaults success to true", () => {
    expect(parseReportBody(JSON.stringify({ dispatchId: "d", summary: "s" }))).toEqual({
      ok: true,
      args: { dispatchId: "d", summary: "s", success: true },
    });
    expect(
      parseReportBody(JSON.stringify({ dispatchId: "d", summary: "s", success: true })).ok,
    ).toBe(true);
  });

  it("parseAskBody keeps options only when present", () => {
    expect(parseAskBody(JSON.stringify({ dispatchId: "d", question: "q" }))).toEqual({
      ok: true,
      args: { dispatchId: "d", question: "q" },
    });
    expect(
      parseAskBody(JSON.stringify({ dispatchId: "d", question: "q", options: ["A"] })),
    ).toEqual({
      ok: true,
      args: { dispatchId: "d", question: "q", options: ["A"] },
    });
  });

  it("parseRestBody treats an empty body as no-arg rest", () => {
    expect(parseRestBody(null)).toEqual({ ok: true, args: {} });
    expect(parseRestBody("{}")).toEqual({ ok: true, args: {} });
    expect(parseRestBody(JSON.stringify({ phrase: "睡" }))).toEqual({
      ok: true,
      args: { phrase: "睡" },
    });
    expect(parseRestBody(JSON.stringify({ phrase: 42 })).ok).toBe(false);
    expect(parseRestBody(JSON.stringify({ title: "整理价格表" }))).toEqual({
      ok: true,
      args: { title: "整理价格表" },
    });
    expect(parseRestBody(JSON.stringify({ title: 42 })).ok).toBe(false);
  });

  it("parseInjectBody validates the source enum", () => {
    expect(parseInjectBody(JSON.stringify({ source: "system", text: "x" }))).toEqual({
      ok: true,
      args: { source: "system", text: "x" },
    });
    expect(parseInjectBody(JSON.stringify({ source: "fax", text: "x" })).ok).toBe(false);
  });

  it("parseInterjectBody validates mode/after enums", () => {
    expect(
      parseInterjectBody(JSON.stringify({ dispatchId: "d", text: "x", mode: "append" })),
    ).toEqual({ ok: true, args: { dispatchId: "d", text: "x", mode: "append" } });
    expect(
      parseInterjectBody(
        JSON.stringify({ dispatchId: "d", text: "x", mode: "checkpoint", after: "wait" }),
      ),
    ).toEqual({
      ok: true,
      args: { dispatchId: "d", text: "x", mode: "checkpoint", after: "wait" },
    });
    expect(
      parseInterjectBody(JSON.stringify({ dispatchId: "d", text: "x", mode: "both" })).ok,
    ).toBe(false);
  });

  it("parseStopBody requires dispatchId", () => {
    expect(parseStopBody(JSON.stringify({ dispatchId: "pix_1" }))).toEqual({
      ok: true,
      args: { dispatchId: "pix_1" },
    });
    expect(parseStopBody(JSON.stringify({})).ok).toBe(false);
  });

  it("parseReportBody keeps kind/files/pause only when present", () => {
    expect(
      parseReportBody(JSON.stringify({ dispatchId: "d", summary: "s", kind: "progress" })),
    ).toEqual({
      ok: true,
      args: { dispatchId: "d", summary: "s", success: true, kind: "progress" },
    });
    expect(
      parseReportBody(JSON.stringify({ dispatchId: "d", summary: "s", kind: "nope" })).ok,
    ).toBe(false);
  });
});
