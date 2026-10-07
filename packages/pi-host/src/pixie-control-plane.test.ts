/**
 * Pixie loopback control-plane contract tests — the Host peer of the
 * my-pi-plugins `packages/pi-pixie/tests/pixie-contract.test.ts` assertions.
 *
 * The plugin's byte-level expectations:
 * - dispatch success 200 `{ ok: true, dispatchId, sessionId, sessionPath, queued }`
 *   (missing a field reads as a contract violation on the plugin side)
 * - dispatch/report failure `{ ok: false, error }` with a readable message
 * - dispatch-state 200 `{ armed: boolean, dispatchId: string | null }`; any
 *   non-200/invalid shape is treated as not-armed by the plugin.
 * Endpoint handlers are exercised directly (no real socket needed) plus one
 * real-socket round trip through startPixieControlPlane.
 */
import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import {
  PIXIE_DISPATCH_PATH,
  PIXIE_DISPATCH_STATE_PATH,
  PIXIE_REPORT_PATH,
  handlePixieControlPlaneRequest,
  parseDispatchBody,
  parseReportBody,
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
    }),
    report: async () => ({ ok: true }),
    dispatchState: () => ({ armed: false, dispatchId: null }),
    ...overrides,
  };
}

describe("pixie control-plane endpoints", () => {
  it("POST /api/pixie/dispatch forwards the body and echoes the engine result", async () => {
    const seen: unknown[] = [];
    const d = deps({
      dispatch: async (request) => {
        seen.push(request);
        return { ok: true, dispatchId: "pix_9", sessionId: "s2", sessionPath: "p", queued: true };
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

  it("GET /api/pixie/dispatch-state returns the armed shape with dispatchId", async () => {
    const d = deps({ dispatchState: () => ({ armed: true, dispatchId: "pix_7" }) });
    const out = await handlePixieControlPlaneRequest(
      d,
      "GET",
      `${PIXIE_DISPATCH_STATE_PATH}?sessionId=s1`,
      null,
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ armed: true, dispatchId: "pix_7" });
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

  it("serves the contract over a real loopback socket", async () => {
    const plane = await startPixieControlPlane(deps());
    try {
      const body = JSON.stringify({ cwd: "C:/ws", task: "t" });
      const status = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: plane.port,
              method: "POST",
              path: PIXIE_DISPATCH_PATH,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
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
        },
      );
      expect(status.status).toBe(200);
      expect(JSON.parse(status.body)).toEqual({
        ok: true,
        dispatchId: "pix_1",
        sessionId: "s1",
        sessionPath: "C:/s1.jsonl",
        queued: false,
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

  it("parseReportBody defaults success to true", () => {
    expect(parseReportBody(JSON.stringify({ dispatchId: "d", summary: "s" }))).toEqual({
      ok: true,
      args: { dispatchId: "d", summary: "s", success: true },
    });
    expect(
      parseReportBody(JSON.stringify({ dispatchId: "d", summary: "s", success: true })).ok,
    ).toBe(true);
  });
});
