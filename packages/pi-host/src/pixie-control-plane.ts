/**
 * Pixie 环回 HTTP 控制面 —— pi-pixie 插件的 Host 对端。
 *
 * 四个内置工具外移到 my-pi-plugins 后，`pixie_dispatch` / `pixie_report` 变成
 * 插件侧工具壳：它们经 `node:http` 直连 127.0.0.1:<PIABYSS_PIXIE_HTTP_PORT>
 * 把执行转发回 Host（禁用全局 fetch：Host 注入的代理设置会拦截环回请求）。
 * 委派引擎本身仍在本进程（pixie-controller 的 dispatchPixieTask + pixie-
 * agent-runner 的 registry），这里只是把它暴露成三个端点：
 *
 * - `POST /api/pixie/dispatch`   { cwd, task, newSession? } → 委派受理结果
 * - `POST /api/pixie/report`     { dispatchId, summary, success } → 回注常驻会话
 * - `GET  /api/pixie/dispatch-state?sessionId=…` → 该会话是否被委派（armed）
 *
 * 响应字段与文案的权威契约在 my-pi-plugins `packages/pi-pixie/README.md`；
 * 插件对非 200 / 非法 JSON / 缺字段一律保守降级（未 armed / 委派失败），
 * 所以正常响应必须 200 + JSON。
 *
 * 依赖注入而非直接引用引擎：端点测试用桩回调即可覆盖契约，不需要搭
 * WorkspaceGraphFactory。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger } from "./logger.js";

/** 单请求体上限：dispatch/report 的 body 都远小于此（防呆）。 */
const MAX_BODY_BYTES = 512 * 1024;

export const PIXIE_DISPATCH_PATH = "/api/pixie/dispatch";
export const PIXIE_REPORT_PATH = "/api/pixie/report";
export const PIXIE_DISPATCH_STATE_PATH = "/api/pixie/dispatch-state";

export type PixieControlPlaneDeps = {
  /** 委派引擎入口（dispatchPixieTask + armPixieDispatch 的组合）。 */
  dispatch: (request: {
    cwd: string;
    task: string;
    newSession?: boolean;
  }) => Promise<
    | { ok: true; dispatchId: string; sessionId: string; sessionPath: string; queued: boolean }
    | { ok: false; error: string }
  >;
  /** 结果回注常驻小精灵会话（deliverReportToPixie）。 */
  report: (args: {
    dispatchId: string;
    summary: string;
    success: boolean;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 按会话解析进行中的委派（findDispatchBySession）。 */
  dispatchState: (sessionId: string) => { armed: boolean; dispatchId: string | null };
};

export type PixieControlPlane = {
  /** 实际绑定的环回端口（监听 127.0.0.1，系统分配）。 */
  port: number;
  close: () => Promise<void>;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload, "utf8"),
  });
  res.end(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      if (!aborted) resolve(null);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** 解析并强校验 dispatch 请求体；失败返回可读中文错误。 */
export function parseDispatchBody(
  raw: string | null,
):
  | { ok: true; request: { cwd: string; task: string; newSession?: boolean } }
  | { ok: false; error: string } {
  if (raw === null) return { ok: false, error: "请求体读取失败" };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "请求体不是合法 JSON" };
  }
  if (!isRecord(value) || typeof value.cwd !== "string" || !value.cwd.trim()) {
    return { ok: false, error: "请求体缺少 cwd（字符串）" };
  }
  if (typeof value.task !== "string" || !value.task.trim()) {
    return { ok: false, error: "请求体缺少 task（字符串）" };
  }
  if (value.newSession !== undefined && typeof value.newSession !== "boolean") {
    return { ok: false, error: "newSession 必须是布尔值" };
  }
  return {
    ok: true,
    request: {
      cwd: value.cwd,
      task: value.task,
      ...(value.newSession !== undefined ? { newSession: value.newSession } : {}),
    },
  };
}

/** 解析并强校验 report 请求体；失败返回可读中文错误。 */
export function parseReportBody(
  raw: string | null,
):
  | { ok: true; args: { dispatchId: string; summary: string; success: boolean } }
  | { ok: false; error: string } {
  if (raw === null) return { ok: false, error: "请求体读取失败" };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "请求体不是合法 JSON" };
  }
  if (!isRecord(value) || typeof value.dispatchId !== "string" || !value.dispatchId.trim()) {
    return { ok: false, error: "请求体缺少 dispatchId（字符串）" };
  }
  if (typeof value.summary !== "string") {
    return { ok: false, error: "请求体缺少 summary（字符串）" };
  }
  if (value.success !== undefined && typeof value.success !== "boolean") {
    return { ok: false, error: "success 必须是布尔值" };
  }
  return {
    ok: true,
    args: {
      dispatchId: value.dispatchId,
      summary: value.summary,
      success: value.success ?? true,
    },
  };
}

/** 请求处理器（独立导出便于单测，不经真实 socket）。 */
export async function handlePixieControlPlaneRequest(
  deps: PixieControlPlaneDeps,
  method: string,
  pathWithQuery: string,
  body: Promise<string | null> | string | null,
): Promise<{ status: number; body: unknown }> {
  const [path, query = ""] = pathWithQuery.split("?");
  const readBodyText = (): Promise<string | null> =>
    typeof body === "string" || body === null ? Promise.resolve(body) : body;

  if (path === PIXIE_DISPATCH_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseDispatchBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.dispatch(parsed.request);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane dispatch failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_REPORT_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseReportBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.report(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane report failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_DISPATCH_STATE_PATH) {
    if (method !== "GET") return { status: 405, body: { ok: false, error: "仅支持 GET" } };
    const params = new URLSearchParams(query);
    const sessionId = params.get("sessionId") ?? "";
    if (!sessionId.trim())
      return { status: 400, body: { ok: false, error: "缺少 sessionId 查询参数" } };
    try {
      return { status: 200, body: deps.dispatchState(sessionId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane dispatch-state failed", { error: message });
      return { status: 200, body: { armed: false, dispatchId: null } };
    }
  }

  return { status: 404, body: { ok: false, error: `未知端点：${path}` } };
}

/**
 * 启动环回控制面。监听 127.0.0.1 的系统分配端口——Host 内的会话与控制面同
 * 进程，没有固定端口需求；插件经 PIABYSS_PIXIE_HTTP_PORT 发现端口（main.ts
 * 在任何会话创建之前写入进程环境）。
 */
export async function startPixieControlPlane(
  deps: PixieControlPlaneDeps,
): Promise<PixieControlPlane> {
  const server: Server = createServer((req, res) => {
    void handlePixieControlPlaneRequest(deps, req.method ?? "GET", req.url ?? "/", readBody(req))
      .then((outcome) => {
        if (!res.writableEnded) sendJson(res, outcome.status, outcome.body);
      })
      .catch((error: unknown) => {
        // readBody resolve(null) 后 req.destroy() 会触发这里的兜底。
        logger.warn("pixie control-plane request crashed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.writableEnded) sendJson(res, 500, { ok: false, error: "控制面内部错误" });
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  logger.info("Pixie loopback control plane listening", { port });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
