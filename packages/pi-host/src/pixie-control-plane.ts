/**
 * Pixie 环回 HTTP 控制面 —— pi-pixie 插件的 Host 对端。
 *
 * v4：插件侧工具壳扩展为五类（dispatch / report / ask / rest / inject 网关
 * 预留），全部经 `node:http` 直连 127.0.0.1:<PIABYSS_PIXIE_HTTP_PORT>（禁用
 * 全局 fetch：Host 注入的代理设置会拦截环回请求）。执行本体仍在本进程：
 *
 * - `POST /api/pixie/dispatch`        { cwd, task, newSession? } → 委派受理结果
 * - `POST /api/pixie/report`          { dispatchId, summary, success } → done/error 回注
 * - `POST /api/pixie/ask`             { dispatchId, question, options? } → 询问用户
 * - `POST /api/pixie/rest`            { phrase?, handoff? } → 小精灵自睡收尾
 * - `POST /api/pixie/inject`          { source, text } → 统一注入入口（网关预留，已实装最小版）
 * - `GET  /api/pixie/dispatch-state`  ?sessionId=… → 该会话是否被委派（armed）+ kind
 *
 * v4 安全：所有端点要求 `X-Piabyss-Pixie-Token` 头（token 由 Host 启动时生成
 * 到 `<agentDir>/piabyss/pixie/control-token`，经 PIABYSS_PIXIE_HTTP_TOKEN 下
 * 发）。破坏性变更：插件与 Host 同版本升级；插件对 401 的保守降级语义（视为
 * 未 armed / 委派失败）正好兼容。
 *
 * 响应字段与文案的权威契约在 my-pi-plugins `packages/pi-pixie/README.md`；
 * 插件对非 200 / 非法 JSON / 缺字段一律保守降级（未 armed / 委派失败），
 * 所以正常响应必须 200 + JSON。
 *
 * 依赖注入而非直接引用引擎：端点测试用桩回调即可覆盖契约，不需要搭
 * WorkspaceGraphFactory。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PixieDispatchKind, PixieStopAction } from "@piabyss/protocol";
import { logger } from "./logger.js";

/** 单请求体上限：dispatch/report/ask 的 body 都远小于此（防呆）。 */
const MAX_BODY_BYTES = 512 * 1024;

export const PIXIE_DISPATCH_PATH = "/api/pixie/dispatch";
export const PIXIE_REPORT_PATH = "/api/pixie/report";
export const PIXIE_ASK_PATH = "/api/pixie/ask";
export const PIXIE_REST_PATH = "/api/pixie/rest";
export const PIXIE_INJECT_PATH = "/api/pixie/inject";
export const PIXIE_DISPATCH_STATE_PATH = "/api/pixie/dispatch-state";
export const PIXIE_INTERJECT_PATH = "/api/pixie/interject";
export const PIXIE_STOP_PATH = "/api/pixie/stop";
export const PIXIE_RETRY_PATH = "/api/pixie/retry";
export const PIXIE_DISPATCHES_PATH = "/api/pixie/dispatches";

/** 控制面鉴权头（v4 token）。 */
export const PIXIE_TOKEN_HEADER = "x-piabyss-pixie-token";

export type PixieControlPlaneDeps = {
  /** 委派引擎入口（dispatchPixieTask，单次注册 + 回合跟踪 + 排队门）。 */
  dispatch: (request: {
    cwd: string;
    task: string;
    newSession?: boolean;
    batchId?: string | null;
    /** 用户明确授权的模型/推理深度覆盖。 */
    model?: string | null;
    thinkingLevel?: string | null;
  }) => Promise<
    | {
        ok: true;
        dispatchId: string;
        sessionId: string;
        sessionPath: string;
        queued: boolean;
        queuedNote?: string;
      }
    | { ok: false; error: string }
  >;
  /** done/error/progress 回注小精灵会话（deliverDispatchCallback）。 */
  report: (args: {
    dispatchId: string;
    summary: string;
    success: boolean;
    /** done | error | progress（非终态进度检查点汇报）。 */
    kind?: "done" | "error" | "progress";
    /** 产物/变更文件清单（progress/done 可带）。 */
    files?: string[] | null;
    /** progress 专用：汇报后暂停（checkpoint wait）。 */
    pause?: boolean;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** ask 询问：记录 → awaiting_user → 信封注入小精灵会话。 */
  ask: (args: {
    dispatchId: string;
    question: string;
    options?: string[];
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 插话（append / checkpoint）：附属于进行中委派，非新任务；可带模型替换。 */
  interject: (args: {
    dispatchId: string;
    text: string;
    mode: "append" | "checkpoint";
    after?: "continue" | "wait";
    model?: string | null;
    thinkingLevel?: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 叫停委派（queued 摘队列 / 运行中 abort），回执明确。 */
  stop: (args: { dispatchId: string }) => Promise<
    { ok: true; action: PixieStopAction } | { ok: false; error: string }
  >;
  /** 重试失败/叫停的委派：resume=原地续跑；redispatch=重派（retryOf 链）。 */
  retry: (args: {
    dispatchId: string;
    mode?: "resume" | "redispatch";
  }) => Promise<{ ok: true; dispatchId: string } | { ok: false; error: string }>;
  /** 查岗：委派记录列表（状态/进度摘要/时间；查岗工具的数据源）。 */
  dispatchList: (limit: number) => unknown[];
  /** pixie_rest：标记休眠请求（下个运行边界收尾换段）。 */
  rest: (args: {
    phrase?: string | null;
    handoff?: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 统一注入入口（网关预留，最小实装）。 */
  inject: (args: {
    source: "ui" | "tg" | "system";
    text: string;
  }) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  /** 按会话解析进行中的委派（findDispatchBySession）。 */
  dispatchState: (sessionId: string) => {
    armed: boolean;
    dispatchId: string | null;
    kind: PixieDispatchKind | null;
  };
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
      if (aborted) resolve(null);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** 委派模型覆盖参数的解析与校验（dispatch / interject 共用）。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PixieModelOverride = {
  model?: string | null;
  thinkingLevel?: string | null;
};

function parseModelOverride(
  value: Record<string, unknown>,
): { ok: true; override: PixieModelOverride } | { ok: false; error: string } {
  if (value.model !== undefined && value.model !== null && typeof value.model !== "string") {
    return { ok: false, error: "model 必须是字符串（provider/id）" };
  }
  if (
    value.thinkingLevel !== undefined &&
    value.thinkingLevel !== null &&
    !THINKING_LEVELS.includes(value.thinkingLevel as (typeof THINKING_LEVELS)[number])
  ) {
    return { ok: false, error: `thinkingLevel 必须是 ${THINKING_LEVELS.join(" | ")}` };
  }
  return {
    ok: true,
    override: {
      ...(value.model !== undefined ? { model: value.model as string | null } : {}),
      ...(value.thinkingLevel !== undefined
        ? { thinkingLevel: value.thinkingLevel as string | null }
        : {}),
    },
  };
}

/** 解析并强校验 dispatch 请求体；失败返回可读中文错误。 */
export function parseDispatchBody(
  raw: string | null,
):
  | {
      ok: true;
      request: {
        cwd: string;
        task: string;
        newSession?: boolean;
        batchId?: string | null;
      } & PixieModelOverride;
    }
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
  if (value.batchId !== undefined && value.batchId !== null && typeof value.batchId !== "string") {
    return { ok: false, error: "batchId 必须是字符串" };
  }
  const override = parseModelOverride(value);
  if (!override.ok) return override;
  return {
    ok: true,
    request: {
      cwd: value.cwd,
      task: value.task,
      ...(value.newSession !== undefined ? { newSession: value.newSession } : {}),
      ...(value.batchId !== undefined ? { batchId: value.batchId as string | null } : {}),
      ...override.override,
    },
  };
}

/** 解析并强校验 report 请求体；失败返回可读中文错误。 */
export function parseReportBody(
  raw: string | null,
):
  | {
      ok: true;
      args: {
        dispatchId: string;
        summary: string;
        success: boolean;
        kind?: "done" | "error" | "progress";
        files?: string[] | null;
        pause?: boolean;
      };
    }
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
  if (
    value.kind !== undefined &&
    value.kind !== "done" &&
    value.kind !== "error" &&
    value.kind !== "progress"
  ) {
    return { ok: false, error: "kind 必须是 done | error | progress" };
  }
  if (
    value.files !== undefined &&
    value.files !== null &&
    (!Array.isArray(value.files) || value.files.some((file) => typeof file !== "string"))
  ) {
    return { ok: false, error: "files 必须是字符串数组" };
  }
  if (value.pause !== undefined && typeof value.pause !== "boolean") {
    return { ok: false, error: "pause 必须是布尔值" };
  }
  return {
    ok: true,
    args: {
      dispatchId: value.dispatchId,
      summary: value.summary,
      success: value.success ?? true,
      ...(value.kind !== undefined ? { kind: value.kind } : {}),
      ...(value.files !== undefined ? { files: value.files as string[] | null } : {}),
      ...(value.pause !== undefined ? { pause: value.pause } : {}),
    },
  };
}

/** 解析并强校验 ask 请求体；失败返回可读中文错误。 */
export function parseAskBody(
  raw: string | null,
):
  | { ok: true; args: { dispatchId: string; question: string; options?: string[] } }
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
  if (typeof value.question !== "string" || !value.question.trim()) {
    return { ok: false, error: "请求体缺少 question（字符串）" };
  }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) || value.options.some((option) => typeof option !== "string"))
  ) {
    return { ok: false, error: "options 必须是字符串数组" };
  }
  return {
    ok: true,
    args: {
      dispatchId: value.dispatchId,
      question: value.question,
      ...(Array.isArray(value.options) ? { options: value.options as string[] } : {}),
    },
  };
}

/** 解析并强校验 rest 请求体；phrase/handoff 均可省略。 */
export function parseRestBody(
  raw: string | null,
): { ok: true; args: { phrase?: string | null; handoff?: string | null } } | { ok: false; error: string } {
  if (raw === null) return { ok: true, args: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "请求体不是合法 JSON" };
  }
  if (!isRecord(value)) return { ok: false, error: "请求体必须是 JSON 对象" };
  if (value.phrase !== undefined && value.phrase !== null && typeof value.phrase !== "string") {
    return { ok: false, error: "phrase 必须是字符串" };
  }
  if (value.handoff !== undefined && value.handoff !== null && typeof value.handoff !== "string") {
    return { ok: false, error: "handoff 必须是字符串" };
  }
  return {
    ok: true,
    args: {
      ...(value.phrase !== undefined ? { phrase: value.phrase as string | null } : {}),
      ...(value.handoff !== undefined ? { handoff: value.handoff as string | null } : {}),
    },
  };
}

/** 解析并强校验 inject 请求体（网关预留）。 */
export function parseInjectBody(
  raw: string | null,
): { ok: true; args: { source: "ui" | "tg" | "system"; text: string } } | { ok: false; error: string } {
  if (raw === null) return { ok: false, error: "请求体读取失败" };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "请求体不是合法 JSON" };
  }
  if (!isRecord(value)) return { ok: false, error: "请求体必须是 JSON 对象" };
  if (value.source !== "ui" && value.source !== "tg" && value.source !== "system") {
    return { ok: false, error: "source 必须是 ui | tg | system" };
  }
  if (typeof value.text !== "string" || !value.text.trim()) {
    return { ok: false, error: "请求体缺少 text（字符串）" };
  }
  return { ok: true, args: { source: value.source, text: value.text } };
}

/** 解析并强校验 interject 请求体（插话：append / checkpoint，可带模型替换）。 */
export function parseInterjectBody(
  raw: string | null,
):
  | {
      ok: true;
      args: {
        dispatchId: string;
        text: string;
        mode: "append" | "checkpoint";
        after?: "continue" | "wait";
      } & PixieModelOverride;
    }
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
  if (typeof value.text !== "string" || !value.text.trim()) {
    return { ok: false, error: "请求体缺少 text（字符串）" };
  }
  if (value.mode !== "append" && value.mode !== "checkpoint") {
    return { ok: false, error: "mode 必须是 append | checkpoint" };
  }
  if (value.after !== undefined && value.after !== "continue" && value.after !== "wait") {
    return { ok: false, error: "after 必须是 continue | wait" };
  }
  const override = parseModelOverride(value);
  if (!override.ok) return override;
  return {
    ok: true,
    args: {
      dispatchId: value.dispatchId,
      text: value.text,
      mode: value.mode,
      ...(value.after !== undefined ? { after: value.after } : {}),
      ...override.override,
    },
  };
}

/** 解析并强校验 stop 请求体（叫停委派）。 */
export function parseStopBody(
  raw: string | null,
): { ok: true; args: { dispatchId: string } } | { ok: false; error: string } {
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
  return { ok: true, args: { dispatchId: value.dispatchId } };
}

/** 解析并强校验 retry 请求体（重试失败/叫停的委派）。 */
export function parseRetryBody(
  raw: string | null,
):
  | { ok: true; args: { dispatchId: string; mode?: "resume" | "redispatch" } }
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
  if (value.mode !== undefined && value.mode !== "resume" && value.mode !== "redispatch") {
    return { ok: false, error: "mode 必须是 resume | redispatch" };
  }
  return {
    ok: true,
    args: {
      dispatchId: value.dispatchId,
      ...(value.mode !== undefined ? { mode: value.mode } : {}),
    },
  };
}

/** 请求处理器（独立导出便于单测，不经真实 socket）。 */
export async function handlePixieControlPlaneRequest(
  deps: PixieControlPlaneDeps,
  method: string,
  pathWithQuery: string,
  body: Promise<string | null> | string | null,
  options: { token?: string | null; headers?: Record<string, string | undefined> } = {},
): Promise<{ status: number; body: unknown }> {
  const [path, query = ""] = pathWithQuery.split("?");
  const readBodyText = (): Promise<string | null> =>
    typeof body === "string" || body === null ? Promise.resolve(body) : body;

  // Token 鉴权：token 未配置（测试桩）时跳过；配置后不匹配一律 401。
  if (options.token) {
    const provided = options.headers?.[PIXIE_TOKEN_HEADER];
    if (provided !== options.token) {
      return { status: 401, body: { ok: false, error: "控制面鉴权失败（token 不匹配）" } };
    }
  }

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

  if (path === PIXIE_ASK_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseAskBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.ask(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane ask failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_REST_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseRestBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.rest(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane rest failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_INJECT_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseInjectBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.inject(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane inject failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_INTERJECT_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseInterjectBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.interject(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane interject failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_STOP_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseStopBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.stop(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane stop failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_RETRY_PATH) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "仅支持 POST" } };
    const parsed = parseRetryBody(await readBodyText());
    if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
    try {
      const result = await deps.retry(parsed.args);
      return { status: 200, body: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane retry failed", { error: message });
      return { status: 200, body: { ok: false, error: message } };
    }
  }

  if (path === PIXIE_DISPATCHES_PATH) {
    if (method !== "GET") return { status: 405, body: { ok: false, error: "仅支持 GET" } };
    const params = new URLSearchParams(query);
    const limitRaw = Number.parseInt(params.get("limit") ?? "20", 10);
    const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20;
    try {
      return { status: 200, body: { ok: true, dispatches: deps.dispatchList(limit) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pixie control-plane dispatches failed", { error: message });
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
      return { status: 200, body: { armed: false, dispatchId: null, kind: null } };
    }
  }

  return { status: 404, body: { ok: false, error: `未知端点：${path}` } };
}

/**
 * 启动环回控制面。监听 127.0.0.1 的系统分配端口——Host 内的会话与控制面同
 * 进程，没有固定端口需求；插件经 PIABYSS_PIXIE_HTTP_PORT 发现端口（main.ts
 * 在任何会话创建之前写入进程环境），token 经 PIABYSS_PIXIE_HTTP_TOKEN 下发。
 */
export async function startPixieControlPlane(
  deps: PixieControlPlaneDeps,
  options: { token?: string | null } = {},
): Promise<PixieControlPlane> {
  const server: Server = createServer((req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
    void handlePixieControlPlaneRequest(
      deps,
      req.method ?? "GET",
      req.url ?? "/",
      readBody(req),
      { token: options.token ?? null, headers },
    )
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
  logger.info("Pixie loopback control plane listening", {
    port,
    tokenAuth: Boolean(options.token),
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
