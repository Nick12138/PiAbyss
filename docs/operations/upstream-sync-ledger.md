# 上游同步台账（Upstream Sync Ledger）

> **用途**：每次与上游（Skitre/PiAbyss）对比功能/修复前，先查本表。凡在"已同步"或"已评估拒绝"清单中的条目，**不再重复提出**，只评估上游新增且未登记的部分。
>
> **对账基线（2026-09-06）**：
> - fork `main` = `edc615f`（已推送 origin）
> - upstream `main` = `5ab0368` —— **upstream 全部历史提交已对账完毕**，下次对比从该提交之后的增量开始
>
> **维护约定**：每完成一次同步/评估，在对应清单登记提交哈希与结论；fork 吸收上游或自研出等价实现后，把条目从"可选"移入"已同步/等价"。

---

## 一、fork 自有等价实现对照（防止把"替代实现"误判为缺口）

| 能力 | fork 实现 | 上游对应 |
|---|---|---|
| 忙碌时切工作区 | Rust HostPool：每工作区独立 Host 进程（`pi_host.rs` prepare_workspace_switch） | 单 Host 保留图驻留（83e93c4）——两条路线，fork 已覆盖全部可感知收益 |
| 工作区内会话驻留 | `backgroundSessions`/`retainBusySession`/`promoteBackgroundRuntime` | 同构 |
| 空闲会话秒开 | `idleSessionCache` 热缓存（env 可调容量/TTL）——**上游没有**（上游 settle 即销毁） | — |
| 跨工作区活动感知 | `pi_host_activity` 快照 + 红绿灰点 + `acknowledgeSessionTerminal` | 上游仅状态点，fork 更细 |
| 空闲资源回收 | `IDLE_HOST_RETENTION` 进程级回收 | 上游仅挂起 provider |
| 思考等级控制 | `ModelControls` thinkingLevel UI（等价 096972b） | 096972b |
| pi.dev 市场分页 | PackagesPage loadMarket（等价 79c9ab0） | 79c9ab0 |
| Pi SDK 0.84.2 | `1310e91` 自移植 patch（等价 63e55f7） | 63e55f7 |
| Host PATH 继承 + bundled 隔离 | `04722c4`（等价 32d223c） | 32d223c |
| Windows Alt+Tab 焦点修复 | `7092469` git patch 钉住（等价 e7c6f2f） | e7c6f2f |
| 包 ENOENT 收紧（npm 路径+配置比对） | `2d626c7`（等价 daad90c/2e4dcad/2183c14 家族） | 同左 |
| 原生系统通知 | 用户自行移植 `64f6604`（= ad3b6eb） | ad3b6eb |
| Telegram 桥接 / 子代理面板 / 插件分级 | fork 独有 | — |

## 二、已同步（2026-09-06 本轮，不要再提）

| 上游提交 | 内容 | fork 落地 |
|---|---|---|
| `44c6818` | dock 文件编辑 + CodeMirror 6 + Markdown 实时预览 + 图片/PDF 媒体预览 + 脏状态守卫 + `workspace.readFilePreview`/`writeTextFile` 协议 | `1e675d6`（拆除只读预览）+ `4acc287`；修复 `bfb65fa`（补齐 require_main_webview） |
| `c5f16f7` | 滚动条常显细腻样式（**仅功能子集**） | `040a655`，8 处使用替换 |
| `d97598f` | Windows 凭据文件 rename 瞬时失败重试 | `4fc62db` |
| `e18877d` | 本地包 update/remove 按 installedPath 匹配 | `2dc106b` |
| `bd62bbd` | select 选项回传原始值 + 跳过空/重复（子集） | `9eaf927` |
| `5ab0368` | 发布证据 pnpm-lock 哈希同步（教训：编辑器依赖变更后刷新 `release-runtime.lock.json`） | `018edc0` |

## 三、已评估拒绝（不要再提）

| 上游提交/主题 | 拒绝原因 |
|---|---|
| 活动会话驻留整线 `83e93c4` + `77c1b18` | fork HostPool 架构已覆盖全部可感知收益；剩余仅 H1-H3 潜在 bug 防护，验证到问题才做（评估记录已删，结论：多进程 vs 单 Host 两条路线各自自洽） |
| 扩展浮窗全链路（`757b133`/`6c56a50`/`fa613f7`/`8fe3791`/`a80cfa6`/`bde9a77`/`30f759e`/`ea227f9`/`d5ba29b`） | **用户明确放弃浮窗** |
| PiDeck→PiCove 品牌改名（`c5f16f7` 主体：README/tauri productName/托盘/i18n/更新源） | 2026-09-07 fork 自主改名为 **PiAbyss**（品牌层全量改名；identifier `com.nick12138.pideck` 与 WebView 数据目录保留不变，防丢渲染层/托盘状态；`<agentDir>/pideck` 数据目录自动迁移至 `piabyss`） |
| 结构化 widget 协议（`36a6264`/`506b2ef`/`2bdf542`/`2c3afa3`） | 与浮窗半耦合 + fork 无结构化扩展 UI 计划（插件分级需求是另一条线） |
| `browser_surface.rs` 物理 DPI 坐标 | 混合 DPI 独立改进，未立项（P5 可选） |
| `model-thinking-profiles.ts` 模型目录刷新 | 与功能无关的目录数据 |
| `8cb8b28` macOS 全屏窗口过渡 | macOS-only |
| `76ba1db`/`dc2e0f9`/`8d943d8`/`076be01` CI 与 macOS 平台修复 | 平台/环境不同 |
| `e4c959e` idle-shutdown 测试 hold | fork 无该机制 |
| `10544bf`/`39ae7d7` knip 未用导出清理 | fork 自行管理 |
| `912a85b` 窄宽度 dock/sidebar chrome | fork 自研布局方案 |
| `94b5548`/`2183c14` 通知 bell 对齐与 ghost | fork 通知自研，无对应面 |
| `3c5ef8d` models.json 首启创建 | fork 无 "Open models.json" 入口，低价值 |
| `77c1b18` 子集：跨工作区启动拒绝 / 树导航投影 / prompt 钉定 / 扩展刷新回滚 | fork 架构下未复现问题（跨工作区拒绝因每 Host 一工作区而不存在）；复现才做 |
| `823c27a`（部分） models.json 一键打开（reveal） | 用户明确不需要（2026-09-07，原第四节可选） |
| `58a9018` 已安装包详情页显示包资源 | 用户明确不需要（2026-09-07，原第四节可选） |
| `4ebe323` usage → 最近活动仪表板 | 用户明确不需要（2026-09-07，原第四节可选） |
| `5d7e90e` 工作区/会话列表可拖动分栏 | 用户明确不需要（2026-09-07，原第四节可选） |

## 四、剩余可选（未同步；需要时点名，不做不提）

> 当前为空：2026-09-07 原四项（`823c27a` 部分 / `58a9018` / `4ebe323` / `5d7e90e`）经用户确认全部不需要，已移入第三节「已评估拒绝」。

## 五、下次对比的操作约定

1. `git fetch upstream --tags`，`git log 5ab0368..upstream/main --oneline`（或以本表记录的最新对账点为 base）；
2. 对照本表：命中"已同步/已拒绝"直接跳过；
3. **fix 类**：核对 fork 是否踩同一坑——必须查端到端调用链（UI→Rust→Host），不能只看单侧代码；fork 已自研等价 ≠ 有缺口；
4. **feat 类**：先确认 fork 是否已有替代实现（对照第一节），再评估移植成本（上游提交可能捆绑已拒绝主题，需按 hunk 甄别）；
5. 同步完成后更新本表（对账基线 + 清单）。
