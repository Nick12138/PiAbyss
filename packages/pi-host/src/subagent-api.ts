/**
 * HTTP client for the my-pi-plugins pi-subagent local API.
 *
 * The pi-subagent extension starts a loopback HTTP server
 * (http://127.0.0.1:<SUBAGENT_HTTP_PORT|18765>) that exposes run status and
 * control endpoints for the PiAbyss panel. See the plugin's http.ts for the
 * exact response shapes.
 *
 * Loopback control-plane calls deliberately use node:http instead of the
 * global fetch: the Host installs an undici EnvHttpProxyAgent (which proxies
 * 127.0.0.1 when NO_PROXY is unset) and a hand-written httpProxy in
 * settings.json must never intercept the local subagent API.
 */
import * as http from "node:http";

const DEFAULT_SUBAGENT_HTTP_PORT = 18765;
const REQUEST_TIMEOUT_MS = 3_000;

/** Resolve the plugin's HTTP API base URL (shared process env). */
function subagentApiBase(): string {
  const port = Number(process.env.SUBAGENT_HTTP_PORT);
  const resolved = Number.isInteger(port) && port > 0 ? port : DEFAULT_SUBAGENT_HTTP_PORT;
  return `http://127.0.0.1:${resolved}`;
}

/** Minimal run summary as returned by `GET /api/runs` (toSummary in http.ts). */
export type SubagentHttpRunSummary = {
  id: string;
  title: string;
  agent: string;
  /** Orchestrator session that spawned the run (null for legacy runs). */
  sessionId?: string | null;
  status: string;
  statusLabel: string;
  pid?: number | null;
  model?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  exitCode?: number | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  resumeCount: number;
  retryLeft: number;
  worktree: boolean;
  worktreePath?: string | null;
  outputPreview: string;
  cost: number;
  turns: number;
};

export type SubagentHttpRunsResponse = {
  runs: SubagentHttpRunSummary[];
  runsRoot: string;
};

export type SubagentHttpControlResponse = {
  ok: boolean;
  error?: string;
};

function rawRequest(path: string, method: "GET" | "POST"): Promise<string | null> {
  return new Promise((resolve) => {
    const { port } = new URL(subagentApiBase());
    const request = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        path,
        method,
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end();
  });
}

/**
 * GET/POST helpers. Transport failures (a missing plugin / connection
 * refused) and non-JSON responses resolve to `null`, which the bridge turns
 * into an "unavailable" snapshot. Non-2xx responses with a JSON body (e.g. a
 * failed control request `{ok:false,error}`) still return their payload so
 * callers can surface the plugin's error message.
 */
async function requestJson<T>(path: string, method: "GET" | "POST"): Promise<T | null> {
  const text = await rawRequest(path, method);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function getSubagentApi<T>(path: string): Promise<T | null> {
  return requestJson<T>(path, "GET");
}

export function postSubagentApi<T>(path: string): Promise<T | null> {
  return requestJson<T>(path, "POST");
}
