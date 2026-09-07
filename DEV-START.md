# PiAbyss 开发启动指南（Windows）

> 本文档总结了为启动开发所完成的全部环境配置，以及日常开发命令与热重载原理。
> 给第一次做桌面应用开发的你。

## ✅ 环境已就绪（已为你配置完成）

| 组件 | 状态 | 版本 / 位置 |
|------|------|------|
| Node.js | ✅ | v24.18.0（匹配 `.node-version`） |
| pnpm | ✅ | 9.15.0（经 corepack 启用） |
| Rust 工具链 | ✅ | 1.97.1 (msvc)，在 `%USERPROFILE%\.cargo\bin` |
| MSVC C++ Build Tools | ✅ | `C:\BuildTools`（cl.exe 14.44.35207） |
| 项目依赖 | ✅ | 716 个包，`pnpm install` 完成 |
| JS 包 build | ✅ | protocol / pi-host / desktop 均已 build |
| Tauri 二进制 | ✅ | `apps/desktop/src-tauri/target/debug/piabyss.exe` 已编译（45s） |

## 🔑 重要：每次新开终端要先做的事

**Rust 和 cargo 装在 `%USERPROFILE%\.cargo\bin`，新开终端如果 PATH 没自动加载，要先加进去。**

PowerShell（推荐，开个新的 PowerShell 终端）：
```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
```

Git Bash：
```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

> 提示：如果你以后想让它自动生效，把那行加到 PowerShell 的 `$PROFILE` 或 Git Bash 的 `~/.bashrc`。

## 🚀 一键启动开发环境

```bash
cd C:/Users/liu/Documents/我的项目/PiAbyss
pnpm --filter @piabyss/desktop run tauri:dev
```

这会同时：
1. 起一个 Vite 前端开发服务器：http://127.0.0.1:1420
2. 启动 Rust 编译好的桌面壳 `piabyss.exe`（已编译过 → 秒开）
3. 内部拉起 Node Pi Host 子进程

第一次启动后，桌面窗口就会弹出来。

## ⚡ Windows 加速启动（推荐用于日常迭代）

项目自带 `pnpm dev:fast`，专门为 Windows 优化的"复用已编译二进制 + 增量同步 host 资源"模式：
- 改了 `packages/pi-host/*`（Agent/工具逻辑）→ 自动增量 build 并同步到 `piabyss.exe` 的资源目录
- 不需要每次重新编译整个 Tauri Rust 工程

```bash
# 前提：先用 tauri:dev 编译过一次（已完成 ✅）
pnpm dev:fast
```

`dev:fast` 会自动：
- 检测 protocol / pi-host TS 源码是否变动 → 增量 build
- 同步到 `apps/desktop/src-tauri/resources/pi-host/`
- 复用 `target/debug/piabyss.exe` 直接启动

## 🔥 热重载（HMR）原理——分三层

| 你改了什么 | 触发什么 | 速度 |
|------|------|------|
| **前端 UI**：`apps/desktop/src/**`（React/TSX/CSS） | Vite HMR，WebView 区域就近刷新，不重启 | 毫秒级 |
| **Pi Host**：`packages/pi-host/src/**`（Agent/工具/会话逻辑） | `dev:fast` 自动重新 build 并同步资源，**下次启动或手动重启 host 生效** | 秒级 |
| **Rust 壳**：`apps/desktop/src-tauri/src/**` | Tauri 自动重新编译并重启桌面壳 | 几秒～几十秒 |

> ⚠️ 注意：Pi Host 子进程是 `piabyss.exe` 启动时拉起的常驻进程。
> 改了 host 的代码后，桌面壳不会自动重启 host——用 `Ctrl+R` 重载窗口，或关掉重启 `pnpm dev:fast`。

## 📝 单独跑某一部分（调试用）

只跑前端（不开桌面壳，纯浏览器，适合只改 UI 时）：
```bash
pnpm dev:desktop    # 浏览器访问 http://localhost:1420
```

只跑 Pi Host（命令行模式，手动给它发 JSONL 协议消息，配合 SDK 冒烟）：
```bash
# Git Bash
export PI_CODING_AGENT_DIR="$TEMP/pi-host-smoke"
pnpm dev:host
```

## 🧪 验证 / 测试

```bash
pnpm typecheck                 # 类型检查
pnpm test                      # 单元测试 + pi-host 集成测试
pnpm verify:quick              # 文档 + 类型 + 测试，本地迭代用
pnpm verify:p0                 # PR 级一站式验证（含前端 prod 构建 + Rust 测试）
```

## 📦 打包成安装包

```bash
pnpm package:release           # 出 Windows x64 NSIS .exe
```

## 🗂️ 开发心智模型（第一次做桌面应用必看）

```
┌─────────────────────────────────────┐
│  Tauri 桌面壳 (Rust 编译，piabyss.exe) │
│  ┌───────────────────────────────┐  │
│  │ WebView2 = 嵌一个 Chromium    │  │  ← 你的 React UI 跑在这里
│  │   └─ apps/desktop/src/**      │  │     Vite HMR，改了秒刷新
│  └───────────────────────────────┘  │
│            ↕ JSONL stdin/stdout    │  ← 协议在这根管子上走
│  Node Pi Host 子进程 (TS)           │  ← packages/pi-host/src/**
│  - 持有 Pi SDK (npm 包)             │     AgentSession 在这跑
│  - 会话 / 工具 / 模型 / Git          │     你给 Agent 加工具就改这
└─────────────────────────────────────┘
```

**所以你的开发对应关系：**
- 改聊天界面 / 主题 / 对话交互 → `apps/desktop/src/**`
- 给 Agent 加新工具（比如 Telegram 网关工具）→ `packages/pi-host/src/**`，仿照 `attachment-tool.ts` 写 `defineTool` 并挂到 `session-lifecycle.ts` 的 `customTools` 数组
- 改桌面原生行为（窗口、托盘、快捷键、文件系统）→ `apps/desktop/src-tauri/src/**`（Rust）

## 🛑 常见问题（来自 docs/operations/development.md）

| 症状 | 解决 |
|------|------|
| Tauri 找不到 host | 确保 `pnpm build` 跑过，`packages/pi-host/dist/main.js` 存在（已 build ✅） |
| `link.exe not found` / 编译失败 | MSVC C++ Build Tools 没装，或 PATH 里没有 `link.exe`（我们已装到 `C:\BuildTools` ✅） |
| `flush stdin: 管道正在被关闭` | 已修；拉取新代码后重新 `pnpm build` 再 `tauri:dev` |
| STALE_REVISION 满屏 | UI 必须从每次响应更新 identity（代码层面问题） |

## ⚠️ 别动真实 agent 数据

写测试或本地跑 host 时，**永远**用临时目录：
```bash
export PI_CODING_AGENT_DIR="$TEMP/piabyss-test-agent"
```
不要把测试写入真实的 `~/.pi/agent`。
