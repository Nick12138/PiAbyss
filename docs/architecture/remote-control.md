# 远程控制（Agents Anywhere）

设置页里的「远程控制」分区负责把 PiAbyss 所在机器接入
[Agents Anywhere](https://github.com/anywhere-labs/Agents-Anywhere)：安装依赖、管理本机
Connector、完成设备配对。页面只做连接管理，**不负责会话读写**——远程查看/续聊由 AA
Connector 里的 runtime 承担，PiAbyss 不对外暴露自己的会话协议。

## 页面流程

```text
未启用 ──「启用并安装」──▶ 安装中（uv → Python 3.12 → anywhere-cli → 校验）
                              │
                              ├─ 成功 ──▶ 管理页（状态 / 启停 / 配对 / 版本 / 日志 / 卸载）
                              └─ 失败 ──▶ 失败页（原因 / 重试 / 打开安装目录 / 关闭）
```

- 开关是**显式总开关**：关闭后页面回到首屏，不下载、不启动任何东西。
- 第一次点击同时写入 `enabled: true` 并开始安装；安装是后台任务，重复点击幂等。
- 安装被中断（Host 退出）时，下次启动把 `installing` 恢复成 `failed`，不会永久卡住。

## 安装位置与卸载

所有产物都在 `<agentDir>/piabyss/remote`：

| 路径 | 内容 |
|---|---|
| `settings.json` | 页面设置（0600，原子替换） |
| `install-state.json` | 安装阶段、步骤、错误、是否由 PiAbyss 装过 Python |
| `install.log` | 安装/运行日志尾部（同时作为状态里的 `logTail` 来源） |
| `bin/uv` | 自行下载的 uv（若系统 PATH 已有 uv 则复用） |
| `python/` | `UV_PYTHON_INSTALL_DIR` |
| `tools/` | `UV_TOOL_DIR`，`anywhere-cli` 的虚拟环境 |
| `connector.log` | Connector 子进程输出（5 MiB 轮转） |

通过 `UV_TOOL_DIR` / `UV_TOOL_BIN_DIR` / `UV_PYTHON_INSTALL_DIR` / `UV_CACHE_DIR` 把 uv
的产物全部收进安装目录，所以“不启用不安装”和“卸载清干净”成立。卸载会停止 Connector、
删除上述安装产物，但**保留** `~/.agents-anywhere`（AA 的账号、设备与同步状态）。

## AA 本机状态（只读）

`aa-state.ts` 只读 AA 自己维护的文件：

- `~/.agents-anywhere/connector.json`：服务地址、设备 id、connector token。token 只用于
  判断“是否已配置”，**不进入协议**。
- `~/.agents-anywhere/connector-runtime.json`：pid、启动来源（`kind`）、设备 id。用于
  区分「PiAbyss 启动的」「其他程序启动的（未运行/运行中）」。
- 数据目录可用 `AGENT_CONNECTOR_DATA_DIR` 覆盖；日志目录为 `<dataDir>/logs`。

进程存活探测在 POSIX 用 `process.kill(pid, 0)`；Windows 用系统自带的 `tasklist`，避免
Node 对非子进程抛错。

## 配对

配对走 AA Server 的公开接口，不依赖 OAuth client：

1. `POST /api/v2/pairing/start` → `{ pairingId, code, expiresAt }`，页面显示 6 位配对码并
   打开 AA 网页。
2. 用户在 AA 网页「添加设备 → 配对码」里输入并确认。
3. `POST /api/v2/pairing/poll` 返回 `claimed` + `config`，PiAbyss 以 0600 原子写入
   `~/.agents-anywhere/connector.json`（含 `heartbeatSeconds` / `reconnectSeconds` 等默认值）。
4. 若已启用且开启自动启动，随后拉起 Connector。

配对过程快照、轮询失败保持 `pending`；过期/失败会清掉页面上的配对码。

## Connector 生命周期

- 启动方式：`spawn(<uv tool 目录>/anywhere-cli/bin/anywhere-cli, ["start"])`，stdin 忽略、
  stdout/stderr 写入 `connector.log`，环境变量 `AGENT_CONNECTOR_CONFIG` 指向上面的配置。
- **不抢方向盘**：`connector-runtime.json` 显示另一个存活进程时状态为 `foreign`，启动/停止
  按钮被禁用，配对会被拒绝（避免改写别的进程正在使用的凭据）；重装/卸载同样会先拒绝，
  否则 uv 会卡在 venv 文件占用上。
- 停止：先 `SIGTERM`，5 秒未退再 `SIGKILL`。
- Host 关闭时由 `onShutdown` 走同一套停止逻辑；Rust 的进程树收容仍然兜底。
- `autoStart` 仅在已安装且已配对时生效，且在 `host.ready` 之后异步触发，不阻塞首屏。

## 协议

均为 Host 作用域（`HostContext`），不带工作区/会话身份：

| 方法 | 参数 | 结果 |
|---|---|---|
| `remote.getStatus` | `null` | `RemoteStatus` |
| `remote.configure` | `Partial<RemoteSettings>` | `RemoteStatus` |
| `remote.install` | `null` | `RemoteStatus`（后台开始安装） |
| `remote.uninstall` | `null` | `RemoteStatus` |
| `remote.setConnectorRunning` | `{ running: boolean }` | `RemoteStatus` |
| `remote.pairStart` | `null` | `{ pairingId, code, webUrl, expiresAt }` |
| `remote.pairPoll` | `{ pairingId }` | `{ state, detail }` |

`RemoteStatus` 汇总：设置、阶段（`idle / installing / installed / failed`）、四步安装状态、
版本、路径、Connector 状态、配对状态、日志尾部，以及 `runtimeSupported / runtimeNote`。

页面用短轮询（安装/配对时 1.2s，其余 5s）刷新；Host 侧对 uv 探测与进程存活分别有
5s / 2s 缓存，避免每次轮询都生成子进程。

## 安全边界

- 协议里没有 token 字段：`RemoteStatus.connector` 只包含设备 id、pid、来源、服务地址。
- `settings.json`、`connector.json`、日志均 0600 写入；安装目录 0700。
- 只与 `127.0.0.1` 之外的 AA Server 通信，不监听任何端口。
- AA Desktop / CLI 已在运行时一律让位，避免同一设备出现两个 Connector。

## 当前边界与 Pi runtime

上游 Connector 默认只注册 Codex / Claude / DSH；Pi runtime 不在上游默认列表里。
PiAbyss 的默认安装源因此指向带 Pi runtime 的维护仓库
`github.com/Nick12138/agents-anywhere-pi#subdirectory=connector`。页面「高级设置」可以
换成别的 commit、fork 或本地目录，改完点「重装依赖」。页面里的「PiAbyss 运行时」状态
按实际安装结果如实显示（已就绪 / 重装后生效 / 取决于 Connector 源）。

本地 fork 的形态（`connector/connector/runtimes/pi/`）：

- `provider.py`：注册 `pi` 类型，配置项为 `piPath` / `agentDir` / `sessionDir` /
  `extensions` / 超时；
- `sessions.py`：扫描 `<agentDir>/sessions/**`，按当前分支把 JSONL 投影成 AA 时间线；
- `rpc.py`：`pi --mode rpc` 的 JSONL 子进程（按会话懒启动、命令关联、扩展 UI 事件）；
- `catalog.py`：把 `models.json` 的 provider `name` 拼进模型标题
  （`供应商 / 模型名`），并按 PiAbyss「设置 → 模型服务」的
  `piabyssEnabledProviders` / `piabyssProviderModels` 过滤——Pi 的 RPC 只返回
  provider id，也不认识 PiAbyss 的启停状态。AA 的模型目录是实时 RPC 读取，
  所以每次在 PiAbyss 里启停供应商/模型，下一次打开 AA 的模型选择器即生效；
  `models.json` 的 mtime 变化会立刻让 Host 侧 60s 缓存失效。
- `runtime.py`：轮询同步（默认），`start_turn` / `steer` / `interrupt` / 模型目录 /
  扩展交互（select/confirm/input/editor → notice）。

限制：attachments 暂不支持；工具调用的自定义渲染在 AA 侧退化为通用工具卡片；Pi 的
`custom()` TUI 面板在手机上不可用。

## 验证

- `packages/pi-host/src/remote/remote-settings.test.ts`：地址归一化、设置持久化/损坏恢复。
- `packages/pi-host/src/remote/aa-state.test.ts`：AA 状态解析、跨平台进程探测。
- `packages/pi-host/src/remote/remote-service.test.ts`：安装步骤/失败重试/卸载、外来
  Connector 避让、配对写入与 token 不外泄。
- `apps/desktop/src/features/remote/RemoteSettings.dom.test.tsx`：首屏、安装中、失败、
  管理页、卸载确认。
