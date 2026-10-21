/**
 * 远程控制（Agents Anywhere）协议形状。
 *
 * PiAbyss 在这一层只负责三件事：把 AA 的 Connector 依赖装到 PiAbyss 自己的目录里、
 * 管理本机的 Connector 进程、以及完成设备配对。会话读写由 AA 侧的 runtime 承担。
 *
 * 隐私约束：任何凭据（connector token、配对凭据）都不允许进入协议，这里只允许出现
 * 掩码后的标识、状态和路径。UI 拿到的就是这些字段，不可能意外打印出 token。
 */

/** 官方云端根地址；`settings.serverUrl` 为空时使用它。 */
export const AA_CLOUD_ORIGIN = "https://web.agents-anywhere.com";

/** 状态里携带的安装日志尾部行数上限。 */
export const MAX_REMOTE_LOG_LINES = 120;
/** 单行日志的最大字符数（超出由 Host 截断，协议不再校验长度）。 */
export const MAX_REMOTE_LOG_LINE_CHARS = 500;

export const REMOTE_INSTALL_STEP_IDS = ["uv", "python", "connector", "verify"] as const;
export type RemoteInstallStepId = (typeof REMOTE_INSTALL_STEP_IDS)[number];

export type RemoteInstallStepState = "pending" | "running" | "done" | "failed" | "skipped";

/** 页面用 stage 决定渲染哪一屏：未启用 / 安装中 / 管理页 / 安装失败。 */
export type RemoteInstallStage = "idle" | "installing" | "installed" | "failed";

export type RemoteConnectorState =
  /** 本机还没有任何 Connector 配置。 */
  | "unconfigured"
  /** 已配置但没在跑。 */
  | "stopped"
  /** PiAbyss 自己拉起来的进程在跑。 */
  | "running"
  /** 由 AA Desktop / CLI 等别的来源在跑，PiAbyss 不抢方向盘。 */
  | "foreign";

export type RemotePairingState = "idle" | "pending" | "claimed" | "expired" | "failed";

export type RemoteInstallStep = {
  id: RemoteInstallStepId;
  state: RemoteInstallStepState;
  /** 失败原因或版本一类的短说明；不做 i18n。 */
  detail: string | null;
};

export type RemoteSettings = {
  /** 「启用远程控制」总开关；关掉后页面回到第一屏。 */
  enabled: boolean;
  /** PiAbyss 启动时自动拉起已配对的 Connector。 */
  autoStart: boolean;
  /** 归一化后的服务根地址；空串表示使用官方云端。 */
  serverUrl: string;
  /** uv 可执行文件覆盖路径；null = 自动探测/自行下载。 */
  uvPath: string | null;
  /** PyPI 索引覆盖（大陆网络常用镜像）；null = 用 Connector 自带索引。 */
  pypiIndex: string | null;
  /** Connector 安装源（PEP 508 片段），高级设置可覆盖。 */
  connectorSource: string;
};

/** `remote.configure` 的增量更新：只提交页面真正改动的字段。 */
export type RemoteSettingsUpdate = Partial<RemoteSettings>;

export type RemoteVersions = {
  uv: string | null;
  python: string | null;
  connector: string | null;
};

export type RemotePaths = {
  /** PiAbyss 自管的安装目录（`<agentDir>/piabyss/remote`）。 */
  installDir: string;
  /** AA 的用户数据目录（`~/.agents-anywhere`）。 */
  dataDir: string;
  connectorConfigPath: string;
  connectorLogPath: string;
  installLogPath: string;
};

export type RemoteConnectorStatus = {
  state: RemoteConnectorState;
  pid: number | null;
  /** AA 记录的主进程来源（desktop / cli / piabyss 等），原样透传。 */
  source: string | null;
  /** 配置文件里的服务地址；未配置为 null。 */
  serverUrl: string | null;
  /** Connector（设备）id；不是密钥，可展示。 */
  connectorId: string | null;
  /** 本机是否已有可用的 Connector 配置。 */
  configured: boolean;
};

export type RemoteStatus = {
  settings: RemoteSettings;
  stage: RemoteInstallStage;
  steps: RemoteInstallStep[];
  /** 最近一次失败的面向用户说明（已本地化的文案由 UI 负责，这里是原因）。 */
  error: string | null;
  versions: RemoteVersions;
  paths: RemotePaths;
  connector: RemoteConnectorStatus;
  pairing: RemotePairingState;
  /** 生效中的服务地址（云端时展开为官方域名）。 */
  activeServerOrigin: string;
  /** 安装日志尾部（有上限）。 */
  logTail: string[];
  /** PiAbyss runtime 是否已被 AA Connector 支持。 */
  runtimeSupported: boolean;
  /** `runtimeSupported` 为 false 时的原因说明。 */
  runtimeNote: string;
  /** 本次状态生成的时间戳（毫秒）。 */
  updatedAt: number;
};

export type RemotePairStartResult = {
  pairingId: string;
  /** 用户要在 AA 网页里输入的配对码。 */
  code: string;
  /** 直接打开就能填码的地址。 */
  webUrl: string;
  /** 过期时间（毫秒）。 */
  expiresAt: number;
};

export type RemotePairPollResult = {
  state: RemotePairingState;
  detail: string | null;
};
