/**
 * HTTP client for the my-pi-plugins pi-schedule local control plane.
 *
 * The pi-schedule extension runs a loopback HTTP server
 * (http://127.0.0.1:<PI_SCHEDULE_PORT|18766>) that exposes job/run control
 * endpoints for the PiAbyss panel. See the plugin's http.ts for the exact
 * response shapes, and docs/CONTRACT.md in the plugin for the integration
 * contract.
 *
 * Loopback control-plane calls deliberately use node:http instead of the
 * global fetch: the Host installs an undici EnvHttpProxyAgent (which proxies
 * 127.0.0.1 when NO_PROXY is unset) and a hand-written httpProxy in
 * settings.json must never intercept the local schedule API.
 *
 * Auth: every endpoint except GET /api/health requires the
 * `X-Pi-Schedule-Token` header. The token lives in `<root>/token`
 * (root = PI_SCHEDULE_DIR or ~/.pi/schedule) or can be provided via the
 * PI_SCHEDULE_TOKEN env var.
 */
import * as http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SCHEDULE_HTTP_PORT = 18766;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type ScheduleApiOutcome<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; error: string };

function scheduleApiPort(): number {
  const raw = process.env.PI_SCHEDULE_PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  }
  return DEFAULT_SCHEDULE_HTTP_PORT;
}

/** Data root of the plugin (mirrors the plugin's own resolution). */
export function scheduleRoot(): string {
  const envDir = process.env.PI_SCHEDULE_DIR?.trim();
  if (envDir) return envDir;
  return join(homedir(), ".pi", "schedule");
}

/** Token for the control plane: env var wins, else <root>/token on disk. */
export function scheduleApiToken(): string | null {
  const fromEnv = process.env.PI_SCHEDULE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = join(scheduleRoot(), "token");
  try {
    if (!existsSync(file)) return null;
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

type RawOutcome =
  | { ok: true; status: number; body: string }
  | { ok: false; status: number | null; error: string };

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
    const token = scheduleApiToken();
    if (token) headers["X-Pi-Schedule-Token"] = token;

    const request = http.request(
      {
        host: "127.0.0.1",
        port: scheduleApiPort(),
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
            resolve({ ok: false, status: response.statusCode ?? null, error: "response too large" });
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
 */
export async function scheduleApi<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<ScheduleApiOutcome<T>> {
  const raw = await rawRequest(path, method, options.body, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
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
