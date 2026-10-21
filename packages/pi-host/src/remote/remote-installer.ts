/**
 * 远程控制依赖安装器。
 *
 * 安装顺序：uv → Python 3.12 → anywhere-cli（Connector）→ 校验。
 * 全部落在 `<agentDir>/piabyss/remote` 里，不碰系统 Python、不写 `~/.local`：
 * 用户不启用远程控制时，机器上不会多出任何东西。
 *
 * 所有外部动作（进程、下载）都通过注入的 `run` / `download` 完成，单测用假实现
 * 覆盖步骤推进和错误分支，不需要网络。
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RemoteInstallStep,
  RemoteInstallStepId,
  RemoteInstallStepState,
  RemoteSettings,
  RemoteVersions,
} from "@piabyss/protocol";

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export type Downloader = (url: string) => Promise<Buffer>;

export type InstallStepReporter = (
  id: RemoteInstallStepId,
  state: RemoteInstallStepState,
  detail: string | null,
) => void;

const MAX_CAPTURE_CHARS = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** Python 首次下载可能很慢，单独放宽。 */
const PYTHON_INSTALL_TIMEOUT_MS = 20 * 60_000;
const CONNECTOR_INSTALL_TIMEOUT_MS = 20 * 60_000;

/** 与 AA 官方安装脚本一致的 uv 发布资产名。 */
function uvAssetName(platform: NodeJS.Platform, arch: string): string | null {
  const windows = platform === "win32";
  const target: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const triple = target[`${platform}-${arch}`];
  if (!triple) return null;
  return windows ? `uv-${triple}.zip` : `uv-${triple}.tar.gz`;
}

function uvDownloadUrl(asset: string): string {
  return `https://github.com/astral-sh/uv/releases/latest/download/${asset}`;
}

function bundledUvPath(installDir: string, platform: NodeJS.Platform): string {
  return join(installDir, "bin", platform === "win32" ? "uv.exe" : "uv");
}

export function connectorBinaryPath(toolDir: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? join(toolDir, "anywhere-cli", "Scripts", "anywhere-cli.exe")
    : join(toolDir, "anywhere-cli", "bin", "anywhere-cli");
}

/**
 * 让 uv 的所有产物（Python、tool 环境、缓存、脚本 shim）都落在 PiAbyss 的安装目录。
 * 这样“不启用不安装 / 卸载就清干净”才是真的，而不是把东西散到用户全局 uv 目录。
 */
export function uvEnvironment(installDir: string, settings: RemoteSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    UV_TOOL_DIR: join(installDir, "tools"),
    UV_TOOL_BIN_DIR: join(installDir, "bin"),
    UV_PYTHON_INSTALL_DIR: join(installDir, "python"),
    UV_CACHE_DIR: join(installDir, "cache"),
  };
  if (settings.pypiIndex) env.UV_DEFAULT_INDEX = settings.pypiIndex;
  return env;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 执行一个命令并收集有界输出；超时先 SIGTERM，再 SIGKILL。 */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ code: null, stdout, stderr: `${stderr}\n[timeout]` });
      }, 3_000);
      killTimer.unref?.();
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

export async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
    throw new Error("下载内容过大");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("下载内容过大");
  return buffer;
}

async function findFile(root: string, name: string, depth = 3): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory() && depth > 0) {
      const nested = await findFile(path, name, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

type ResolveUvOptions = {
  installDir: string;
  settings: RemoteSettings;
  platform: NodeJS.Platform;
  arch: string;
  run: CommandRunner;
  download: Downloader;
  log: (line: string) => void;
};

/** 返回可用的 uv 路径；必要时下载官方发布包解压到安装目录。 */
async function ensureUv(options: ResolveUvOptions): Promise<string> {
  const { installDir, settings, platform, arch, run, download, log } = options;
  if (settings.uvPath && (await pathExists(settings.uvPath))) return settings.uvPath;
  const bundled = bundledUvPath(installDir, platform);
  if (await pathExists(bundled)) return bundled;

  // 系统 PATH 上已有 uv 时直接复用，避免重复下载。
  const probe = await run("uv", ["--version"], {
    timeoutMs: 20_000,
    env: uvEnvironment(installDir, settings),
  });
  if (probe.code === 0) {
    log(`reuse uv from PATH: ${probe.stdout.trim()}`);
    return "uv";
  }

  const asset = uvAssetName(platform, arch);
  if (!asset) throw new Error(`当前平台没有可用的 uv 发布包（${platform}/${arch}）`);
  const url = uvDownloadUrl(asset);
  log(`downloading ${url}`);
  const bytes = await download(url);
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  const archive = join(installDir, asset);
  await writeFile(archive, bytes, { mode: 0o600 });
  const extractDir = join(installDir, "uv-extract");
  await mkdir(extractDir, { recursive: true, mode: 0o700 });
  const tarArgs =
    platform === "linux" ? ["-xzf", archive, "-C", extractDir] : ["-xf", archive, "-C", extractDir];
  const extracted = await run("tar", tarArgs, { timeoutMs: 120_000 });
  if (extracted.code !== 0) {
    throw new Error(`解压 uv 失败：${extracted.stderr.trim() || "tar 返回非零状态"}`);
  }
  const found = await findFile(extractDir, platform === "win32" ? "uv.exe" : "uv");
  if (!found) throw new Error("解压后没有找到 uv 可执行文件");
  await mkdir(join(installDir, "bin"), { recursive: true, mode: 0o700 });
  const destination = bundledUvPath(installDir, platform);
  await writeFile(destination, await readFile(found));
  if (platform !== "win32") await chmod(destination, 0o755);
  log(`uv installed at ${destination}`);
  return destination;
}

async function uvVersion(
  uv: string,
  run: CommandRunner,
  env: NodeJS.ProcessEnv = {},
): Promise<string | null> {
  const result = await run(uv, ["--version"], { timeoutMs: 20_000, env });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function findPython312(
  uv: string,
  run: CommandRunner,
  env: NodeJS.ProcessEnv = {},
): Promise<string | null> {
  const result = await run(uv, ["python", "find", "3.12"], { timeoutMs: 30_000, env });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function uvToolDir(
  uv: string,
  run: CommandRunner,
  env: NodeJS.ProcessEnv = {},
): Promise<string | null> {
  const result = await run(uv, ["tool", "dir"], { timeoutMs: 30_000, env });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export type EnvironmentProbe = {
  uv: { path: string | null; version: string | null };
  python: { path: string | null; version: string | null };
  connector: { path: string | null; version: string | null };
  toolsAvailable: boolean;
};

/** 只读探测：用于页面状态，不触发任何安装动作。 */
export async function probeEnvironment(options: {
  installDir: string;
  settings: RemoteSettings;
  platform: NodeJS.Platform;
  arch: string;
  run: CommandRunner;
}): Promise<EnvironmentProbe> {
  const { installDir, settings, platform, run } = options;
  const candidate =
    settings.uvPath && (await pathExists(settings.uvPath))
      ? settings.uvPath
      : (await pathExists(bundledUvPath(installDir, platform)))
        ? bundledUvPath(installDir, platform)
        : null;
  const uvCommand = candidate ?? "uv";
  const env = uvEnvironment(installDir, settings);
  const version = await uvVersion(uvCommand, run, env);
  if (!version) {
    return {
      uv: { path: null, version: null },
      python: { path: null, version: null },
      connector: { path: null, version: null },
      toolsAvailable: false,
    };
  }
  const pythonPath = await findPython312(uvCommand, run, env);
  const toolDir = await uvToolDir(uvCommand, run, env);
  const connectorPath =
    toolDir && (await pathExists(connectorBinaryPath(toolDir, platform)))
      ? connectorBinaryPath(toolDir, platform)
      : null;
  const list = connectorPath
    ? await run(uvCommand, ["tool", "list"], { timeoutMs: 30_000, env })
    : null;
  const connectorVersion =
    list?.code === 0
      ? ((/(?:^|\n)anywhere-cli v?([^\s]+)/u.exec(list.stdout)?.[1] ?? null)?.trim() ?? null)
      : null;
  return {
    uv: { path: candidate ?? "uv", version },
    python: { path: pythonPath, version: pythonPath ? "3.12" : null },
    connector: { path: connectorPath, version: connectorVersion },
    toolsAvailable: Boolean(connectorPath),
  };
}

export type InstallRunResult =
  { ok: true; versions: RemoteVersions; pythonInstalled: boolean } | { ok: false; error: string };

/** 执行完整安装；每一步通过 `report` 推进页面状态，失败即停。 */
export async function runInstall(options: {
  installDir: string;
  settings: RemoteSettings;
  platform: NodeJS.Platform;
  arch: string;
  run: CommandRunner;
  download: Downloader;
  report: InstallStepReporter;
  log: (line: string) => void;
}): Promise<InstallRunResult> {
  const { installDir, settings, platform, arch, run, download, report, log } = options;
  const fail = async (step: RemoteInstallStepId, error: string): Promise<InstallRunResult> => {
    report(step, "failed", error);
    return { ok: false, error };
  };

  report("uv", "running", null);
  let uv: string;
  try {
    uv = await ensureUv({ installDir, settings, platform, arch, run, download, log });
  } catch (error) {
    return fail("uv", error instanceof Error ? error.message : String(error));
  }
  const uvVersionText = await uvVersion(uv, run);
  if (!uvVersionText) return fail("uv", "uv 安装后无法执行");
  report("uv", "done", uvVersionText);
  log(`uv ready: ${uvVersionText}`);

  const env = uvEnvironment(installDir, settings);
  report("python", "running", null);
  const existingPython = await findPython312(uv, run, env);
  let pythonInstalled = false;
  if (existingPython) {
    report("python", "done", existingPython);
    log(`python 3.12 ready: ${existingPython}`);
  } else {
    await mkdir(join(installDir, "python"), { recursive: true, mode: 0o700 });
    const result = await run(uv, ["python", "install", "3.12"], {
      timeoutMs: PYTHON_INSTALL_TIMEOUT_MS,
      env,
    });
    if (result.code !== 0) {
      return fail("python", result.stderr.trim() || result.stdout.trim() || "Python 3.12 安装失败");
    }
    const installed = await findPython312(uv, run, env);
    if (!installed) return fail("python", "Python 3.12 安装后仍不可见");
    pythonInstalled = true;
    report("python", "done", installed);
    log(`python 3.12 installed: ${installed}`);
  }

  report("connector", "running", null);
  const install = await run(
    uv,
    ["tool", "install", "--from", settings.connectorSource, "anywhere-cli"],
    { timeoutMs: CONNECTOR_INSTALL_TIMEOUT_MS, env },
  );
  if (install.code !== 0) {
    return fail(
      "connector",
      install.stderr.trim() || install.stdout.trim() || "anywhere-cli 安装失败",
    );
  }
  const toolDir = await uvToolDir(uv, run, env);
  if (!toolDir) return fail("connector", "无法定位 uv tool 目录");
  if (!(await pathExists(connectorBinaryPath(toolDir, platform)))) {
    return fail("connector", "安装完成但没有找到 anywhere-cli 可执行文件");
  }
  report("connector", "done", null);
  log("anywhere-cli installed");

  report("verify", "running", null);
  const probe = await probeEnvironment({ installDir, settings, platform, arch, run });
  if (!probe.toolsAvailable) return fail("verify", "校验失败：anywhere-cli 不可执行");
  report("verify", "done", probe.connector.version);
  log("install verified");
  return {
    ok: true,
    versions: {
      uv: probe.uv.version,
      python: probe.python.version,
      connector: probe.connector.version,
    },
    pythonInstalled,
  };
}

/** 初始步骤表（pending），供状态接口与安装流程共用。 */
export function initialInstallSteps(): RemoteInstallStep[] {
  return [
    { id: "uv", state: "pending", detail: null },
    { id: "python", state: "pending", detail: null },
    { id: "connector", state: "pending", detail: null },
    { id: "verify", state: "pending", detail: null },
  ];
}
