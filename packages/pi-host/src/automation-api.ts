/**
 * HTTP client for the my-pi-plugins pi-automation local control plane.
 *
 * The pi-automation extension runs a loopback HTTP server
 * (http://127.0.0.1:<PI_AUTOMATION_PORT|18766>) that exposes job/run control
 * endpoints for the PiAbyss panel. See the plugin's http.ts for the exact
 * response shapes, and docs/CONTRACT.md in the plugin for the integration
 * contract.
 *
 * Loopback control-plane calls deliberately use node:http instead of the
 * global fetch: the Host installs an undici EnvHttpProxyAgent (which proxies
 * 127.0.0.1 when NO_PROXY is unset) and a hand-written httpProxy in
 * settings.json must never intercept the local automation API.
 *
 * Auth: every endpoint except GET /api/health requires the
 * `X-Pi-Automation-Token` header. The token lives in `<root>/token`
 * (root = PI_AUTOMATION_DIR, or the pre-rename PI_SCHEDULE_DIR, or
 * ~/.pi/automation) or can be provided via the PI_AUTOMATION_TOKEN env var.
 * Host startup pins PI_AUTOMATION_TOKEN before any extension loads (see
 * main.ts), so both sides of this loopback handshake read one value; the file
 * stays for callers outside the process.
 *
 * Both env spellings are read everywhere: the plugin accepts the old names too,
 * and if Host only read one of them the two sides would silently disagree about
 * which directory the token lives in — that shows up as a 401 on every call,
 * not as an error message about the env var.
 */
import * as http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_AUTOMATION_HTTP_PORT = 18766;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type AutomationApiOutcome<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number | null; error: string };

/** 新名优先，旧名（pi-schedule 时代）兜底——与插件的 readEnvWithLegacy 同一套规则。 */
function envWithLegacy(name: string, legacyName: string): string | undefined {
  const fresh = process.env[name]?.trim();
  if (fresh) return fresh;
  return process.env[legacyName]?.trim() || undefined;
}

function automationApiPort(): number {
  const raw = envWithLegacy("PI_AUTOMATION_PORT", "PI_SCHEDULE_PORT");
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  }
  return DEFAULT_AUTOMATION_HTTP_PORT;
}

/** Data root of the plugin (mirrors the plugin's own resolution). */
export function automationRoot(): string {
  const envDir = envWithLegacy("PI_AUTOMATION_DIR", "PI_SCHEDULE_DIR");
  if (envDir) return envDir;
  return join(homedir(), ".pi", "automation");
}

/** Token for the control plane: env var wins, else <root>/token on disk. */
export function automationApiToken(): string | null {
  const fromEnv = envWithLegacy("PI_AUTOMATION_TOKEN", "PI_SCHEDULE_TOKEN");
  if (fromEnv) return fromEnv;
  const file = join(automationRoot(), "token");
  try {
    if (!existsSync(file)) return null;
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

type RawOutcome =
  { ok: true; status: number; body: string } | { ok: false; status: number | null; error: string };

function rawRequest(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  timeoutMs: number,
): Promise<RawOutcome> {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string | number> = { Accept: "application/json" };
    if (payload !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const token = automationApiToken();
    if (token) headers["X-Pi-Automation-Token"] = token;

    const request = http.request(
      {
        host: "127.0.0.1",
        port: automationApiPort(),
        path,
        method,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            resolve({
              ok: false,
              status: response.statusCode ?? null,
              error: "response too large",
            });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            ok: true,
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error: Error) => {
          resolve({ ok: false, status: null, error: error.message });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, status: null, error: "request timeout" });
    });
    request.on("error", (error: Error) => {
      resolve({ ok: false, status: null, error: error.message });
    });
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/**
 * GET/POST/PATCH/DELETE helper. Transport failures (plugin not running /
 * connection refused / timeout) return ok:false with status:null. Non-2xx
 * responses still return their JSON body via ok:true when parseable — the
 * caller decides how to map status codes to protocol errors.
 *
 * A request that needs auth but has no token locally is answered here instead
 * of being sent: the plugin's reply would be the generic "缺少或错误的 token",
 * which blames the control plane for a token the Host never had.
 */
export async function automationApi<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<AutomationApiOutcome<T>> {
  if (path !== "/api/health" && automationApiToken() === null) {
    return {
      ok: false,
      status: 401,
      error: `本地未取到控制面 token（PI_AUTOMATION_TOKEN 未设置，且 ${join(automationRoot(), "token")} 不存在或为空）`,
    };
  }
  const raw = await rawRequest(
    path,
    method,
    options.body,
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  if (!raw.ok) return raw;

  let parsed: unknown = undefined;
  if (raw.body.trim().length > 0) {
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      return { ok: false, status: raw.status, error: `invalid JSON response (HTTP ${raw.status})` };
    }
  }

  if (raw.status < 200 || raw.status >= 300) {
    const message =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${raw.status}`;
    return { ok: false, status: raw.status, error: message };
  }
  return { ok: true, status: raw.status, data: parsed as T };
}
