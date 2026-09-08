# Pi Coding Agent —— 用户级 / 项目级加载路径汇总

Pi 启动时会从**全局（用户）目录**和**项目目录**加载上下文文件、系统提示、技能（Skills）和提示模板（Prompt Templates）。项目级资源需要**项目被信任（trust）**后才会加载。

级别说明：`全局` = 用户目录，`项目` = 项目目录（需信任），`CLI` = 命令行参数。

## 一、资源加载总表

### 📄 上下文文件（Context Files，自动拼入系统提示）

| 级别 | 加载路径 | 说明 / 禁用方式 |
| --- | --- | --- |
| 全局 | `~/.pi/agent/AGENTS.md` | 从 cwd 向上逐级查找父目录，所有匹配文件**拼接**。禁用：`--no-context-files` / `-nc` |
| 项目 | 父目录（从 cwd 向上遍历）中的 `AGENTS.md` / `CLAUDE.md` | 同上 |
| 项目 | 当前目录的 `AGENTS.md` / `CLAUDE.md` | 同上 |

### 🧠 系统提示（System Prompt）

| 级别 | 加载路径 | 说明 |
| --- | --- | --- |
| 项目 / 全局 | `.pi/SYSTEM.md`（项目）<br>`~/.pi/agent/SYSTEM.md`（全局） | **替换**默认系统提示 |
| 项目 / 全局 | `APPEND_SYSTEM.md`（同上述两处目录） | 在默认提示后**追加**，不替换 |
| CLI | `--system-prompt <text>`<br>`--append-system-prompt <text>` | 替换 / 追加；替换时上下文文件和技能仍会附加 |

### 🛠 技能（Skills，含 `SKILL.md` 的目录或单个 .md）

| 级别 | 加载路径 | 说明 |
| --- | --- | --- |
| 全局 | `~/.pi/agent/skills/` | 根目录下直接的 `.md` 文件也算单个技能 |
| 全局 | `~/.agents/skills/` | 根 `.md` 会被忽略，只发现含 `SKILL.md` 的目录（递归） |
| 项目 | `.pi/skills/` | 需项目信任；根 `.md` 可用 |
| 项目 | `.agents/skills/`（cwd 及祖先目录，上至 git 仓库根） | 需项目信任；根 `.md` 被忽略 |
| 包 / 设置 / CLI | 包的 `skills/` 目录或 `package.json` 的 `pi.skills`；settings 的 `skills` 数组；`--skill <path>` | 禁用发现：`--no-skills`（显式 `--skill` 仍加载）；可手动 `/skill:name` 触发 |

### 📝 提示模板（Prompt Templates，`/name` 命令，非递归）

| 级别 | 加载路径 | 说明 |
| --- | --- | --- |
| 全局 | `~/.pi/agent/prompts/*.md` | 文件名即命令名（`review.md` → `/review`） |
| 项目 | `.pi/prompts/*.md` | 需项目信任 |
| 包 / 设置 / CLI | 包的 `prompts/` 或 `pi.prompts`；settings 的 `prompts` 数组；`--prompt-template <path>` | 禁用发现：`--no-prompt-templates` |

### ⚙️ 设置文件

| 级别 | 加载路径 | 说明 |
| --- | --- | --- |
| 全局 / 项目 | `~/.pi/agent/settings.json`<br>`.pi/settings.json`（覆盖全局） | 内含 `skills`、`prompts` 数组可指定额外目录 |
| 全局 | `~/.pi/agent/trust.json` | 保存项目信任决定（`/trust` 命令写入） |

## 二、项目信任时序

> **信任决定前**，Pi 只加载：上下文文件（AGENTS.md）、全局扩展、CLI `-e` 扩展。
>
> **信任决定后**，才加载项目级资源：`.pi/settings.json`、`.pi/skills/`、`.pi/prompts/`、项目扩展等。
>
> 非交互模式由全局设置 `defaultProjectTrust`（`ask` / `always` / `never`）控制，可用 `--approve` / `-a` 或 `--no-approve` / `-na` 单次覆盖。

## 三、路径速查（Windows 示例）

| 级别 | Linux / macOS | Windows |
| --- | --- | --- |
| 全局根目录 | `~/.pi/agent/` | `C:\Users\<用户名>\.pi\agent\` |
| 项目根目录 | `<项目目录>/.pi/` 和 `<项目目录>/.agents/` | 同左（Windows/Linux/macOS 写法一致） |
