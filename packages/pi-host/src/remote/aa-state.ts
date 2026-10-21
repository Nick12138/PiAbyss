/**
 * Agents Anywhere 在本机留下的状态（只读）。
 *
 * AA 自己的数据目录是 `~/.agents-anywhere`（可用 `AGENT_CONNECTOR_DATA_DIR` 覆盖），
 * 里面有两份我们关心的文件：
 * - `connector.json`：服务地址、设备 id、凭据（凭据只报告"是否存在"，绝不读出）；
 * - `connector-runtime.json`：当前 Connector 的启动记录（pid / 来源 / 设备）。
 *
 * 这里不做任何写入：配置文件归 AA 自己管，PiAbyss 只在配对成功后写一次（见
 * `remote-service.ts`），并由 AA 的 CLI 读取。
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AaConnectorConfig = {
  serverUrl: string;
  connectorId: string;
  /** 只暴露"有没有"，token 本身不进入这个类型。 */
  hasToken: boolean;
};

export type AaRuntimeRecord = {
  pid: number;
  /** AA 记录的启动来源（cli / desktop / rpc…），旧版文件可能缺失。 */
  kind: string | null;
  connectorId: string | null;
  serverUrl: string | null;
  startedAt: string | null;
};

const MAX_CONFIG_BYTES = 256 * 1024;

export function aaDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.AGENT_CONNECTOR_DATA_DIR?.trim();
  return override ? override : join(home, ".agents-anywhere");
}

function aaConnectorConfigPath(dataDir: string): string {
  return join(dataDir, "connector.json");
}

function aaRuntimeRecordPath(dataDir: string): string {
  return join(dataDir, "connector-runtime.json");
}

export function aaLogDir(dataDir: string): string {
  return join(dataDir, "logs");
}

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf8");
    if (text.length > MAX_CONFIG_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readAaConnectorConfig(dataDir: string): Promise<AaConnectorConfig | null> {
  const raw = await readJson(aaConnectorConfigPath(dataDir));
  if (!isRecord(raw)) return null;
  const serverUrl = readString(raw, "serverUrl");
  const connectorId = readString(raw, "connectorId");
  if (!serverUrl || !connectorId) return null;
  return {
    serverUrl,
    connectorId,
    hasToken: Boolean(readString(raw, "connectorToken")),
  };
}

export async function readAaRuntimeRecord(dataDir: string): Promise<AaRuntimeRecord | null> {
  const raw = await readJson(aaRuntimeRecordPath(dataDir));
  if (!isRecord(raw)) return null;
  // v2：{ version: 2, runtime: { pid, kind, connectorId, serverUrl, startedAt } }
  const runtime = isRecord(raw.runtime) ? raw.runtime : raw;
  const pid = runtime.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    pid,
    kind: readString(runtime, "kind"),
    connectorId: readString(runtime, "connectorId"),
    serverUrl: readString(runtime, "serverUrl"),
    startedAt: readString(runtime, "startedAt"),
  };
}

/**
 * 进程存活探测。
 *
 * Windows 上不能用 `process.kill(pid, 0)`：Node 对非子进程会直接抛错，AA 自己也
 * 因此改用了别的探测方式。这里退到 `tasklist`（系统自带、无需额外依赖）。
 */
export async function isProcessAlive(
  pid: number,
  deps: {
    platform?: NodeJS.Platform;
    runTasklist?: (pid: number) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const probe = deps.runTasklist ?? runTasklistProbe;
    try {
      return await probe(pid);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function runTasklistProbe(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 2_000);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < 8_192) output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // 匹配 CSV 行里的 PID 列，避免 "1234" 命中 "12345"。
      resolve(new RegExp(`,"?${pid}"?,`).test(output));
    });
  });
}
