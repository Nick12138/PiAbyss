/**
 * 远程控制的本地设置（Host 侧唯一事实来源）。
 *
 * 为什么放在 Host 而不是 desktopSettings：安装目录、uv/Python 探测、Connector 进程
 * 都属于 Host 的生命周期，Rust 侧不需要知道这些；页面只通过 `remote.*` 方法读写。
 *
 * 文件位于 `<agentDir>/piabyss/remote/settings.json`（0600，原子替换）。这里只存
 * "怎么装/怎么连"，不存任何凭据；Connector 的 token 始终由 AA 自己的
 * `~/.agents-anywhere/connector.json` 持有。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RemoteSettings, RemoteSettingsUpdate } from "@piabyss/protocol";

/**
 * 默认安装源。
 *
 * 用主分支而不是某个 tag：AA 的 connector 版本与产品版本相互独立，仓库当前也没有
 * 为 connector 单独打 tag；页面「高级设置」允许用户把它换成某个 commit 或本地目录，
 * 需要可复现部署时改这里即可。
 */
export const DEFAULT_CONNECTOR_SOURCE =
  "git+https://github.com/anywhere-labs/Agents-Anywhere.git#subdirectory=connector";

const MAX_SERVER_URL_LENGTH = 2_048;

export function defaultRemoteSettings(): RemoteSettings {
  return {
    enabled: false,
    autoStart: true,
    serverUrl: "",
    uvPath: null,
    pypiIndex: null,
    connectorSource: DEFAULT_CONNECTOR_SOURCE,
  };
}

/**
 * 归一化服务地址，规则与 AA 桌面端一致：
 * - 省略 scheme 时补 `https://`；
 * - 去掉结尾的 `/` 和误粘贴的 `/api/v2`；
 * - 只接受 http/https，保留自定义路径前缀（反向代理场景）。
 *
 * 返回空串表示"使用官方云端"。
 */
export function normalizeServerUrl(raw: string): { serverUrl: string; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { serverUrl: "", error: null };
  if (trimmed.length > MAX_SERVER_URL_LENGTH) {
    return { serverUrl: "", error: "服务地址过长" };
  }
  if (/[\u0000-\u001f\u007f\s]/u.test(trimmed)) {
    return { serverUrl: "", error: "服务地址包含非法字符" };
  }
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { serverUrl: "", error: "无法解析服务地址" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { serverUrl: "", error: "服务地址必须是 http 或 https" };
  }
  url.hash = "";
  url.search = "";
  let path = url.pathname.replace(/\/+$/u, "");
  if (path.toLowerCase().endsWith("/api/v2")) {
    path = path.slice(0, -"/api/v2".length).replace(/\/+$/u, "");
  }
  return { serverUrl: `${url.origin}${path}`, error: null };
}

function normalizeLoadedSettings(value: unknown): RemoteSettings {
  const defaults = defaultRemoteSettings();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
  const source = value as Record<string, unknown>;
  const readBoolean = (key: string, fallback: boolean): boolean =>
    typeof source[key] === "boolean" ? (source[key] as boolean) : fallback;
  const readNullableString = (key: string): string | null => {
    const raw = source[key];
    if (raw === null || raw === undefined) return null;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  };
  const rawServerUrl = typeof source.serverUrl === "string" ? source.serverUrl : "";
  const normalized = normalizeServerUrl(rawServerUrl);
  return {
    enabled: readBoolean("enabled", defaults.enabled),
    autoStart: readBoolean("autoStart", defaults.autoStart),
    // 文件被手改坏时退回云端，而不是让页面卡在非法地址上。
    serverUrl: normalized.error ? "" : normalized.serverUrl,
    uvPath: readNullableString("uvPath"),
    pypiIndex: readNullableString("pypiIndex"),
    connectorSource:
      typeof source.connectorSource === "string" && source.connectorSource.trim()
        ? source.connectorSource.trim()
        : defaults.connectorSource,
  };
}

export class RemoteSettingsStore {
  readonly path: string;

  constructor(installDir: string) {
    this.path = join(installDir, "settings.json");
  }

  async load(): Promise<RemoteSettings> {
    try {
      const text = await readFile(this.path, "utf8");
      return normalizeLoadedSettings(JSON.parse(text) as unknown);
    } catch {
      // 缺失、损坏、权限问题都退回默认值：页面永远能打开。
      return defaultRemoteSettings();
    }
  }

  /** 合并式保存：只覆盖调用方提交的字段，并返回保存后的完整设置。 */
  async save(patch: RemoteSettingsUpdate): Promise<RemoteSettings> {
    const current = await this.load();
    const next: RemoteSettings = { ...current };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.autoStart !== undefined) next.autoStart = patch.autoStart;
    if (patch.serverUrl !== undefined) {
      const normalized = normalizeServerUrl(patch.serverUrl);
      if (normalized.error) throw new Error(normalized.error);
      next.serverUrl = normalized.serverUrl;
    }
    if (patch.uvPath !== undefined) {
      next.uvPath = patch.uvPath === null || !patch.uvPath.trim() ? null : patch.uvPath.trim();
    }
    if (patch.pypiIndex !== undefined) {
      next.pypiIndex =
        patch.pypiIndex === null || !patch.pypiIndex.trim() ? null : patch.pypiIndex.trim();
    }
    if (patch.connectorSource !== undefined && patch.connectorSource.trim()) {
      next.connectorSource = patch.connectorSource.trim();
    }
    await this.write(next);
    return next;
  }

  async write(settings: RemoteSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
