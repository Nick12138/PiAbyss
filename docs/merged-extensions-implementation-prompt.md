# 任务：把 PiAbyss 设置中的「插件库」与「包管理」合并为一个「扩展」页

## 背景

- 项目：Tauri 2 + React 19 + TypeScript + Tailwind CSS 4（`@theme` token + CSS 变量）+ Zustand；i18n 用自研 `useT()`，中文文案在 `apps/desktop/src/lib/i18n/zh.ts`。
- 现有两个待合并页面：
  - 包管理：`apps/desktop/src/features/packages/PackagesPage.tsx`（已安装双栏列表+详情 / 市场网格；横幅、进度条、确认弹窗、pi.dev 分页目录）
  - 插件库：`apps/desktop/src/features/plugin-library/PluginLibraryPage.tsx`（管理范围 chips、可更新下拉、卡片网格、启停 Switch、配置对话框）
- 设置壳与导航：`apps/desktop/src/features/settings/SettingsPage.tsx`（`SETTINGS_NAV`）+ `settings-top-bar.tsx`（顶栏动作 Portal）。
- **视觉与交互基准（已确认的原型，严格照它的结构/交互/文案做）：`docs/merged-extensions-prototype.html`** —— 纯 HTML+原生 JS，打开即可体验：Tab 切换、范围联动、详情抽屉、筛选、全局无继承等。

## 目标信息架构

1. `SETTINGS_NAV` 删除 `plugins` 与 `packages` 两项，新增一项「扩展」（i18n key 建议 `navExtensions`；图标可用 Blocks 或保留 Puzzle），section id 建议 `extensions`。同步英文文案，注意 knip/eslint 对未使用导出的检查。
2. 页面只有两个 Tab（沿用 `data-ui="segmented"` 分段控件）：**「插件库」（默认）、「市场」**。
3. 顶栏动作合并：可更新按钮（ArrowDownToLine + warning 数字角标 + 下拉：标题「N 项可更新」/「全部更新」链接/逐项「当前版 → 可用版」/单项更新按钮，更新中转 spinner）+ 刷新按钮 + 「pi.dev 目录」外链（仅市场 Tab 显示）。原两页的 Portal 注入逻辑合并进新页。

## 插件库 Tab（已安装 + 插件目录合一）

- **不再有独立的「已安装」双栏视图。** 一个卡片网格（沿用原 PluginCard 样式与 `@min-[36rem]`/`@min-[64rem]` 断点），混排插件（my-pi-plugins 注册表）与包（npm/git）。
- 卡片状态：已安装 → 启停 Switch（乐观更新、失败回滚，复用现有逻辑）；未安装 → 主按钮「安装…」（确认弹窗文案照旧）；可更新 → warning「可更新」徽章；**点击卡片本体 → 右侧详情抽屉**（内部按钮需 `stopPropagation`）。
- 详情抽屉（替代原「已安装」右栏；宽约 430px、Esc 与点遮罩关闭、关闭后焦点归还）：
  - 头部：图标 + 名称 + 类型徽章 + 版本（有更新时显示 → 可用版本）；操作行：更新（有更新时）/ 打开文件夹 / 移除（danger tone，确认弹窗复用原文案「将从 Agent 中移除该包及其资源…」）。
  - 「包详情」dl：来源 / 标识（mono）/ 类型与版本 / 安装路径。
  - 「包内资源」：启停汇总（N 个启用 / M 个禁用）+ 包级分段 + 按 extension/skill/prompt/theme 分组行（复用原渲染），行内「继承/启用/禁用」分段、「仅手动」「生效中/未生效」等标注照旧。
- 工具栏一行：搜索框 + 状态筛选（全部状态/已安装/未安装/可更新）+ 类型筛选（全部类型/插件/包/扩展/技能/提示词/主题）+ 右侧「npm:包名、git URL 或本地路径」输入 + 「安装…」主按钮（确认弹窗与本地代码风险提示文案照旧）。

## 管理范围（scope）规则（原型已定，勿改语义）

- 「管理范围」chips 行（全局 + 各工作区；当前工作区 chip 带绿点；选中态 `border-accent/60 bg-accent/10`）在**插件库 Tab 显示、市场 Tab 隐藏**；与 Tab 分段控件放同一行右侧。
- 切范围 → 网格按该范围重新渲染：插件按该范围的安装/启停状态；**包为用户级，任何范围都显示**（项目范围下卡片加「全局」小徽章，启停走该范围的资源偏好）。
- 仅全局插件：项目范围下显示只读「仅全局」徽章，Switch 点击只提示「仅全局插件请在「全局」范围下启停」。
- 配置齿轮：仅「全局」范围且插件有 config 时显示（打开原 `PluginConfigDialog`）。
- 未安装插件默认显示（来源 `my-pi-plugins` 注册表），「安装…」**仅「全局」范围可点**；所有工作区范围一律禁用并 title「未安装的插件只能在全局安装（用户级）：工作区只负责启停，不单独安装。」（安装只落用户级，避免同一插件按工作区分裂成多份安装记录）。
- 安装态以宿主快照的 `record.installed` 为准（有已解析的安装路径）：工作区 `.pi/settings.json` 里残留配置但磁盘上没有该包时不显示启停开关，一律按「未安装」处理。
- 安装确认文案：注册表插件安装统一为用户级 =「写入你的用户级 pi 设置」（工作区不可触发安装）。
- **全局范围下，包内资源的分段控制不显示「继承」**（只保留 启用/禁用）；数据中继承态的资源在全局按实际生效状态渲染。
- 插件卡片标签行带来源小标 `my-pi-plugins`（accent 色 tag）；网格上方说明行：「管理范围：{X} · 用户级/项目级/只读预览 · 插件来源：my-pi-plugins」。

## 市场 Tab

- 基本照搬原市场网格（搜索/类型/排序/刷新/分页/卡片/「已安装 ✓」），样式不动。
- 安装按钮提示文案统一为：「包可以执行本地代码。确认后将安装到全局（用户级），之后可在插件库按工作区管理。」（确认弹窗仍用原 install 风险全文）。
- 市场不显示管理范围 chips。

## 其他保持不变

- 横幅区（包操作进度、applying-preferences、reconcile 警告、reloadRequired、刷新失败）保留在 Tab 内容上方，逻辑复用。
- `runMutation`、`refresh` 的 SERVICE_GRAPH_BUSY 指数退避、跨范围串行更新防 STALE_REVISION、更新预取缓存等既有逻辑全部保留，只改挂载位置。
- 安装/更新/移除三种确认弹窗的文案与 tone 照旧。
- 颜色、间距、字号全部沿用 `index.css` 现有 token，不引入新视觉语言；响应式与 `scrollbar-subtle` 照旧。

## 验收

- `pnpm -w build` / tsc 通过，eslint 无新告警，相关单测通过。
- 手测清单：Tab 切换（市场隐藏范围行）；范围切换联动卡片状态；全局无「继承」；仅全局插件在项目范围只读；**所有工作区范围的未安装插件安装按钮均禁用**（仅全局可安装）；抽屉打开/关闭（Esc、遮罩）；可更新下拉与「全部更新」；三种确认弹窗；zh/en 文案无缺 key。

## 实施建议

- 新建 `features/extensions/ExtensionsPage.tsx` 及子组件（LibraryGrid / ExtensionsDrawer / MarketGrid / 承接原弹窗）；旧两页删除或改为兼容重导出，更新 `SettingsPage.tsx`、`Sidebar.tsx` 引用与 i18n。
- 数据形状可参考原型脚本里的 `ITEMS`（`kind: 'plugin' | 'package'`、`states` 按范围、`resources` 分组），对应到现有的 store/命令层。
