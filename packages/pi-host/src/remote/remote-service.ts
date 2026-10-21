/**
 * 远程控制（Agents Anywhere）Host 服务。
 *
 * 负责：依赖安装、Connector 进程管理、设备配对、状态汇总。
 * 不负责：会话读写（那是 AA Connector 里 runtime 的事）。
 *
 * 设计约束：
 * - 不抢方向盘：AA 的运行记录（`connector-runtime.json`）显示别的来源在跑时，
 *   只报告 foreign，不启动第二个实例；
 * - 凭据只进不出：配对成功写一次 `~/.agents-anywhere/connector.json`（0600），
 *   之后状态里只出现设备 id；
 * - 页面轮询友好：状态读取有短 TTL 缓存，不会每秒打一堆子进程。
 */
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import {
  AA_CLOUD_ORIGIN,
  MAX_REMOTE_LOG_LINE_CHARS,
  MAX_REMOTE_LOG_LINES,
  type RemoteConnectorState,
  type RemoteInstallStage,
  type RemoteInstallStep,
  type RemotePairPollResult,
  type RemotePairStartResult,
  type RemotePairingState,
  type RemoteSettings,
  type RemoteSettingsUpdate,
  type RemoteStatus,
  type RemoteVersions,
} from "@piabyss/protocol";
import { logger } from "../logger.js";
import {
  aaDataDir,
  isProcessAlive,
  readAaConnectorConfig,
  readAaRuntimeRecord,
} from "./aa-state.js";
import {
  connectorBinaryPath,
  downloadFile,
  initialInstallSteps,
  probeEnvironment,
  runCommand,
  runInstall,
  uvEnvironment,
  type CommandRunner,
  type Downloader,
  type EnvironmentProbe,
} from "./remote-installer.js";
import { RemoteSettingsStore } from "./remote-settings.js";

const PAIRING_TTL_SECONDS = 600;
const MAX_CONNECTOR_LOG_BYTES = 5 * 1024 * 1024;
const PROBE_TTL_MS = 5_000;
const ALIVE_TTL_MS = 2_000;
const STOP_GRACE_MS = 5_000;

type InstallState = {
  stage: RemoteInstallStage;
  steps: RemoteInstallStep[];
  error: string | null;
  /** 这次安装是否由 PiAbyss 装过 Python；卸载时据此决定要不要 `uv python uninstall`。 */
  pythonInstalledByPiAbyss: boolean;
  updatedAt: number;
};

type PairingSession = {
  pairingId: string;
  code: string;
  expiresAt: number;
  state: RemotePairingState;
  detail: string | null;
};

export type RemoteServiceOptions = {
  agentDir: string;
  /** 覆盖 AA 数据目录（测试用）。 */
  dataDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  run?: CommandRunner;
  download?: Downloader;
  fetchImpl?: typeof fetch;
  /** 进程存活探测覆盖（测试用）。 */
  isAlive?: (pid: number) => Promise<boolean>;
};

export class RemoteService {
  readonly installDir: string;
  private readonly settingsStore: RemoteSettingsStore;
  private readonly dataDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly now: () => number;
  private readonly run: CommandRunner;
  private readonly download: Downloader;
  private readonly fetchImpl: typeof fetch;
  private readonly isAlive: (pid: number) => Promise<boolean>;

  private readonly logLines: string[] = [];
  private installState: InstallState = {
    stage: "idle",
    steps: initialInstallSteps(),
    error: null,
    pythonInstalledByPiAbyss: false,
    updatedAt: 0,
  };
  private installPromise: Promise<void> | null = null;
  private pairing: PairingSession | null = null;
  private child: { pid: number; startedAt: number; log: WriteStream } | null = null;
  private probeCache: { at: number; value: EnvironmentProbe } | null = null;
  private aliveCache: { pid: number; at: number; alive: boolean } | null = null;
  private restored = false;
  /** 串行化安装状态落盘，避免并发 rename 争同一个临时文件。 */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: RemoteServiceOptions) {
    this.installDir = join(options.agentDir, "piabyss", "remote");
    this.settingsStore = new RemoteSettingsStore(this.installDir);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.now = options.now ?? Date.now;
    this.run = options.run ?? runCommand;
    this.download = options.download ?? downloadFile;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.isAlive = options.isAlive ?? ((pid) => isProcessAlive(pid, { platform: this.platform }));
    this.dataDir = options.dataDir ?? aaDataDir(process.env);
  }

  get paths() {
    return {
      installDir: this.installDir,
      dataDir: this.dataDir,
      connectorConfigPath: join(this.dataDir, "connector.json"),
      connectorLogPath: join(this.installDir, "connector.log"),
      installLogPath: join(this.installDir, "install.log"),
    };
  }

  /** 启动时恢复安装状态并（按需）拉起已配对的 Connector。 */
  async ensureAutoStart(): Promise<void> {
    await this.restoreInstallState();
    const settings = await this.settingsStore.load();
    if (!settings.enabled || !settings.autoStart) return;
    if (!(await this.installed())) return;
    if (!(await readAaConnectorConfig(this.dataDir))) return;
    try {
      await this.startConnector(settings);
    } catch (error) {
      // 自动启动失败不能拖垮 Host 启动；页面会显示原因。
      this.log(`auto-start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async status(): Promise<RemoteStatus> {
    await this.restoreInstallState();
    const settings = await this.settingsStore.load();
    const [config, runtime] = await Promise.all([
      readAaConnectorConfig(this.dataDir),
      readAaRuntimeRecord(this.dataDir),
    ]);
    const runtimeAlive = runtime ? await this.alive(runtime.pid) : false;
    const childAlive = this.child ? await this.alive(this.child.pid) : false;
    if (this.child && !childAlive) {
      this.child.log.end();
      this.child = null;
    }
    let state: RemoteConnectorState;
    if (!config) state = "unconfigured";
    else if (childAlive || (runtimeAlive && this.child?.pid === runtime?.pid)) state = "running";
    else if (runtimeAlive) state = "foreign";
    else state = "stopped";

    const probe = await this.probe(settings);
    const versions: RemoteVersions = {
      uv: probe.uv.version,
      python: probe.python.version,
      connector: probe.connector.version,
    };
    const stage = this.resolveStage(probe);
    return {
      settings,
      stage,
      steps: this.installState.steps.map((step) => ({ ...step })),
      error: this.installState.error,
      versions,
      paths: this.paths,
      connector: {
        state,
        pid: childAlive ? (this.child?.pid ?? null) : runtimeAlive ? (runtime?.pid ?? null) : null,
        source: childAlive ? "piabyss" : runtimeAlive ? (runtime?.kind ?? null) : null,
        serverUrl: config?.serverUrl ?? runtime?.serverUrl ?? null,
        connectorId: runtime?.connectorId ?? config?.connectorId ?? null,
        configured: Boolean(config),
      },
      pairing: this.pairing?.state ?? "idle",
      activeServerOrigin: settings.serverUrl || AA_CLOUD_ORIGIN,
      logTail: this.tail(),
      // 上游还没有 pi runtime：页面如实说明，而不是让用户以为装完就能远程开会话。
      runtimeSupported: false,
      runtimeNote:
        "上游 Connector 默认只含 Codex / Claude / DSH。Pi runtime 需要把「高级设置 → Connector 安装源」指向包含 pi provider 的源（例如本地 fork），重装后才会出现在 AA 里。",
      updatedAt: this.now(),
    };
  }

  async configure(patch: RemoteSettingsUpdate): Promise<RemoteStatus> {
    const previous = await this.settingsStore.load();
    const next = await this.settingsStore.save(patch);
    this.probeCache = null;
    if (previous.enabled && !next.enabled) {
      await this.stopConnector().catch(() => undefined);
    }
    if (!previous.enabled && next.enabled && (await this.installed())) {
      // 已装好、只是之前关掉了开关：重新打开时恢复连接。
      if (next.autoStart && (await readAaConnectorConfig(this.dataDir))) {
        await this.startConnector(next).catch((error) => {
          this.log(`resume failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    return this.status();
  }

  /** 幂等：正在安装时直接返回当前状态，重复点击不会开第二个安装。 */
  async install(): Promise<RemoteStatus> {
    await this.restoreInstallState();
    if (this.installPromise) return this.status();
    // 重装会替换 venv：先停掉 PiAbyss 自己拉起的进程；别的来源在跑则拒绝，
    // 否则 uv 会卡在“另一个程序正在使用此文件”。
    if (this.child) {
      await this.stopConnector().catch(() => undefined);
    } else {
      await this.assertNoForeignConnector();
    }
    await this.settingsStore.save({ enabled: true });
    const settings = await this.settingsStore.load();
    this.installState = {
      stage: "installing",
      steps: initialInstallSteps(),
      error: null,
      pythonInstalledByPiAbyss: this.installState.pythonInstalledByPiAbyss,
      updatedAt: this.now(),
    };
    this.log("install started");
    await this.persistInstallState();
    this.installPromise = this.runInstallJob(settings).finally(() => {
      this.installPromise = null;
    });
    return this.status();
  }

  private async runInstallJob(settings: RemoteSettings): Promise<void> {
    try {
      const result = await runInstall({
        installDir: this.installDir,
        settings,
        platform: this.platform,
        arch: this.arch,
        run: this.run,
        download: this.download,
        report: (id, state, detail) => {
          this.installState = {
            ...this.installState,
            steps: this.installState.steps.map((step) =>
              step.id === id ? { ...step, state, detail } : step,
            ),
            updatedAt: this.now(),
          };
          void this.persistInstallState();
        },
        log: (line) => this.log(line),
      });
      if (result.ok) {
        this.installState = {
          ...this.installState,
          stage: "installed",
          error: null,
          pythonInstalledByPiAbyss: result.pythonInstalled,
          updatedAt: this.now(),
        };
        this.log("install finished");
      } else {
        this.installState = {
          ...this.installState,
          stage: "failed",
          error: result.error,
          updatedAt: this.now(),
        };
        this.log(`install failed: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.installState = {
        ...this.installState,
        stage: "failed",
        error: message,
        updatedAt: this.now(),
      };
      this.log(`install failed: ${message}`);
    } finally {
      this.probeCache = null;
      await this.persistInstallState();
      if (this.installState.stage === "installed" && settings.autoStart) {
        const config = await readAaConnectorConfig(this.dataDir);
        if (config) {
          await this.startConnector(settings).catch((error) => {
            this.log(
              `start after install failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }
    }
  }

  /** 卸载依赖并关闭开关；保留 settings.json（高级配置与服务器地址）。 */
  async uninstall(): Promise<RemoteStatus> {
    await this.restoreInstallState();
    if (this.installPromise) throw new Error("安装正在进行，请等待完成后再卸载");
    await this.persistChain;
    await this.assertNoForeignConnector();
    await this.stopConnector().catch(() => undefined);
    const settings = await this.settingsStore.load();
    const probe = await this.probe(settings);
    const uv = probe.uv.path;
    if (uv) {
      const env = uvEnvironment(this.installDir, settings);
      await this.run(uv, ["tool", "uninstall", "anywhere-cli"], {
        timeoutMs: 120_000,
        env,
      }).catch(() => undefined);
      if (this.installState.pythonInstalledByPiAbyss) {
        await this.run(uv, ["python", "uninstall", "3.12"], {
          timeoutMs: 120_000,
          env,
        }).catch(() => undefined);
      }
    }
    for (const entry of ["bin", "uv-extract", "python", "install.log", "install-state.json"]) {
      await rm(join(this.installDir, entry), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    // 下载的归档也清掉（保留 settings.json）。
    try {
      for (const name of await readdir(this.installDir)) {
        if (name.startsWith("uv-") && name !== "uv-extract") {
          await rm(join(this.installDir, name), { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }
    } catch {
      // 目录不存在时忽略。
    }
    this.installState = {
      stage: "idle",
      steps: initialInstallSteps(),
      error: null,
      pythonInstalledByPiAbyss: false,
      updatedAt: this.now(),
    };
    this.probeCache = null;
    await this.persistInstallState();
    await this.settingsStore.save({ enabled: false });
    this.logLines.length = 0;
    return this.status();
  }

  async setConnectorRunning(running: boolean): Promise<RemoteStatus> {
    if (running) {
      const settings = await this.settingsStore.load();
      await this.startConnector(settings);
    } else {
      await this.stopConnector();
    }
    return this.status();
  }

  async pairStart(): Promise<RemotePairStartResult> {
    const settings = await this.settingsStore.load();
    const origin = settings.serverUrl || AA_CLOUD_ORIGIN;
    const payload = await this.postJson(`${origin}/api/v2/pairing/start`, {
      serverUrl: origin,
      ttlSeconds: PAIRING_TTL_SECONDS,
    });
    const pairingId = readString(payload, "pairingId");
    const code = readString(payload, "code");
    const expiresAt = parseTime(payload["expiresAt"]);
    if (!pairingId || !code) throw new Error("服务端没有返回配对码");
    const expiry = expiresAt ?? this.now() + PAIRING_TTL_SECONDS * 1000;
    this.pairing = { pairingId, code, expiresAt: expiry, state: "pending", detail: null };
    return { pairingId, code, webUrl: origin, expiresAt: expiry };
  }

  async pairPoll(pairingId: string): Promise<RemotePairPollResult> {
    const session = this.pairing;
    if (!session || session.pairingId !== pairingId) {
      return { state: "failed", detail: "配对会话不存在或已过期" };
    }
    if (session.expiresAt <= this.now()) {
      this.pairing = { ...session, state: "expired", detail: null };
      return { state: "expired", detail: null };
    }
    const settings = await this.settingsStore.load();
    const origin = settings.serverUrl || AA_CLOUD_ORIGIN;
    let payload: Record<string, unknown>;
    try {
      payload = await this.postJson(`${origin}/api/v2/pairing/poll`, { pairingId });
    } catch (error) {
      return {
        state: "pending",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const status = readString(payload, "status");
    if (status === "claimed") {
      const config = payload.config;
      try {
        await this.assertNoForeignConnector();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.pairing = { ...session, state: "failed", detail };
        return { state: "failed", detail };
      }
      if (!isRecord(config)) {
        this.pairing = { ...session, state: "failed", detail: "服务端返回的凭据不完整" };
        return { state: "failed", detail: this.pairing.detail };
      }
      try {
        await this.writeConnectorConfig(config);
      } catch (error) {
        this.pairing = {
          ...session,
          state: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
        return { state: "failed", detail: this.pairing.detail };
      }
      this.pairing = { ...session, state: "claimed", detail: null };
      if (settings.enabled && settings.autoStart) {
        await this.startConnector(settings).catch((error) => {
          this.log(
            `start after pair failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return { state: "claimed", detail: null };
    }
    if (status === "expired" || status === "consumed") {
      this.pairing = { ...session, state: "expired", detail: null };
      return { state: "expired", detail: null };
    }
    return { state: "pending", detail: null };
  }

  /** 等待进行中的安装结束（测试与优雅关闭用）。 */
  async waitForInstall(): Promise<void> {
    await this.installPromise;
  }

  async dispose(): Promise<void> {
    await this.stopConnector({ graceMs: 1_500 }).catch(() => undefined);
  }

  // ---- 内部实现 ----

  /** 别的进程正在跑 Connector 时，不允许改写它的凭据或另起一个实例。 */
  private async assertNoForeignConnector(): Promise<void> {
    const runtime = await readAaRuntimeRecord(this.dataDir);
    if (!runtime) return;
    if (runtime.pid === this.child?.pid) return;
    if (await this.alive(runtime.pid)) {
      throw new Error("其他程序正在运行 Connector，请先在那边退出再配对");
    }
  }

  private async startConnector(settings: RemoteSettings): Promise<void> {
    if (this.child) {
      const alive = await this.alive(this.child.pid);
      if (alive) return;
      this.child.log.end();
      this.child = null;
    }
    const runtime = await readAaRuntimeRecord(this.dataDir);
    if (runtime && (await this.alive(runtime.pid))) {
      throw new Error("本机 Connector 已由其他程序启动（AA Desktop 或 CLI），请先在那边退出");
    }
    const config = await readAaConnectorConfig(this.dataDir);
    if (!config) throw new Error("请先完成设备配对");
    const probe = await this.probe(settings);
    if (!probe.toolsAvailable) throw new Error("依赖尚未安装完整，请先重新安装");
    const toolDir = await this.toolDir(probe.uv.path, settings);
    if (!toolDir) throw new Error("无法定位 anywhere-cli 的安装目录");
    const binary = connectorBinaryPath(toolDir, this.platform);
    await mkdir(this.installDir, { recursive: true, mode: 0o700 });
    await this.rotateConnectorLog();
    const log = createWriteStream(this.paths.connectorLogPath, { flags: "a", mode: 0o600 });
    const child = spawn(binary, ["start"], {
      cwd: this.installDir,
      env: {
        ...process.env,
        AGENT_CONNECTOR_CONFIG: this.paths.connectorConfigPath,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log.write(text);
      for (const line of text.split(/\r?\n/u)) {
        if (line.trim()) this.log(`[connector] ${line}`);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      this.log(`connector spawn error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.log(`connector exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      const current = this.child;
      if (current && current.pid === child.pid) {
        current.log.end();
        this.child = null;
      }
    });
    if (!child.pid) {
      log.end();
      throw new Error("Connector 未能启动");
    }
    this.child = { pid: child.pid, startedAt: this.now(), log };
    this.aliveCache = null;
    this.log(`connector started (pid=${child.pid})`);
  }

  private async stopConnector(options: { graceMs?: number } = {}): Promise<void> {
    const child = this.child;
    if (!child) {
      const runtime = await readAaRuntimeRecord(this.dataDir);
      if (runtime && (await this.alive(runtime.pid))) {
        throw new Error("Connector 由其他程序管理，请在那边的界面退出");
      }
      return;
    }
    const graceMs = options.graceMs ?? STOP_GRACE_MS;
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // 进程可能已经退出。
    }
    const exited = await waitForExit((pid) => this.alive(pid), child.pid, graceMs);
    if (!exited) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // 忽略：进程已退出。
      }
    }
    child.log.end();
    this.child = null;
    this.aliveCache = null;
    this.log("connector stopped");
  }

  private async rotateConnectorLog(): Promise<void> {
    try {
      const info = await stat(this.paths.connectorLogPath);
      if (info.size > MAX_CONNECTOR_LOG_BYTES) {
        await rename(this.paths.connectorLogPath, `${this.paths.connectorLogPath}.1`);
      }
    } catch {
      // 第一次启动没有日志文件。
    }
  }

  private async installed(): Promise<boolean> {
    const settings = await this.settingsStore.load();
    const probe = await this.probe(settings);
    return probe.toolsAvailable;
  }

  private resolveStage(probe: EnvironmentProbe): RemoteInstallStage {
    if (this.installPromise || this.installState.stage === "installing") return "installing";
    if (this.installState.stage === "failed") return "failed";
    if (probe.toolsAvailable) return "installed";
    return "idle";
  }

  private async probe(settings: RemoteSettings): Promise<EnvironmentProbe> {
    if (this.probeCache && this.now() - this.probeCache.at < PROBE_TTL_MS) {
      return this.probeCache.value;
    }
    const value = await probeEnvironment({
      installDir: this.installDir,
      settings,
      platform: this.platform,
      arch: this.arch,
      run: this.run,
    });
    this.probeCache = { at: this.now(), value };
    return value;
  }

  private async toolDir(uv: string | null, settings: RemoteSettings): Promise<string | null> {
    if (!uv) return null;
    const result = await this.run(uv, ["tool", "dir"], {
      timeoutMs: 30_000,
      env: uvEnvironment(this.installDir, settings),
    });
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  private async alive(pid: number): Promise<boolean> {
    if (
      this.aliveCache &&
      this.aliveCache.pid === pid &&
      this.now() - this.aliveCache.at < ALIVE_TTL_MS
    ) {
      return this.aliveCache.alive;
    }
    const alive = await this.isAlive(pid);
    this.aliveCache = { pid, at: this.now(), alive };
    return alive;
  }

  private log(line: string): void {
    const trimmed = line.replace(/\s+$/u, "").slice(0, MAX_REMOTE_LOG_LINE_CHARS);
    if (!trimmed) return;
    this.logLines.push(trimmed);
    if (this.logLines.length > MAX_REMOTE_LOG_LINES * 2) {
      this.logLines.splice(0, this.logLines.length - MAX_REMOTE_LOG_LINES);
    }
    const path = this.paths.installLogPath;
    void mkdir(this.installDir, { recursive: true, mode: 0o700 })
      .then(() => appendFile(path, `${trimmed}\n`, { mode: 0o600 }))
      .catch((error) => {
        logger.warn("Failed to append remote install log", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private tail(): string[] {
    return this.logLines.slice(-MAX_REMOTE_LOG_LINES);
  }

  private async restoreInstallState(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    try {
      const raw = JSON.parse(
        await readFile(join(this.installDir, "install-state.json"), "utf8"),
      ) as Partial<InstallState>;
      const steps = Array.isArray(raw.steps) ? raw.steps : initialInstallSteps();
      const stage: RemoteInstallStage =
        raw.stage === "installing"
          ? // 上次退出时安装被中断：不能永久停在 installing。
            "failed"
          : raw.stage === "installed" || raw.stage === "failed"
            ? raw.stage
            : "idle";
      this.installState = {
        stage,
        steps: initialInstallSteps().map((step) => {
          const saved = steps.find((candidate) => candidate.id === step.id);
          return saved ? { ...step, state: saved.state, detail: saved.detail ?? null } : step;
        }),
        error: stage === "failed" ? (raw.error ?? "上次安装被中断，请重试") : (raw.error ?? null),
        pythonInstalledByPiAbyss: Boolean(raw.pythonInstalledByPiAbyss),
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      };
      const rawLines = await readFile(this.paths.installLogPath, "utf8").catch(() => "");
      if (rawLines) {
        this.logLines.push(
          ...rawLines
            .split(/\r?\n/u)
            .filter((line) => line.length > 0)
            .slice(-MAX_REMOTE_LOG_LINES),
        );
      }
    } catch {
      // 没有历史状态：保持 idle。
    }
  }

  private persistInstallState(): Promise<void> {
    this.persistChain = this.persistChain
      .then(async () => {
        const snapshot = this.installState;
        await mkdir(this.installDir, { recursive: true, mode: 0o700 });
        const path = join(this.installDir, "install-state.json");
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(snapshot, null, 2)}
`,
          {
            mode: 0o600,
          },
        );
        await rename(temporary, path);
      })
      .catch((error) => {
        logger.warn("Failed to persist remote install state", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return this.persistChain;
  }

  private async writeConnectorConfig(config: Record<string, unknown>): Promise<void> {
    const serverUrl = readString(config, "serverUrl");
    const connectorId = readString(config, "connectorId");
    const connectorToken = readString(config, "connectorToken");
    if (!serverUrl || !connectorId || !connectorToken) {
      throw new Error("配对凭据不完整");
    }
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const path = this.paths.connectorConfigPath;
    const temporary = join(this.dataDir, `.connector.json.${process.pid}.tmp`);
    const payload = {
      serverUrl,
      connectorId,
      connectorToken,
      heartbeatSeconds: 20,
      reconnectSeconds: 3,
      syncExistingOnConnect: true,
      syncIntervalSeconds: 30,
    };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = isRecord(parsed) ? readString(parsed, "detail") : null;
      throw new Error(detail ?? `服务端返回 HTTP ${response.status}`);
    }
    if (!isRecord(parsed)) throw new Error("服务端返回了非 JSON 响应");
    return parsed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function waitForExit(
  isAlive: (pid: number) => Promise<boolean>,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
