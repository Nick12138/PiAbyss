# 任务：小精灵页右侧面板改造（可展开折叠 + 委派任务区域按新设计重做）

> 这是一份自包含的实施说明。请先通读「硬约束」，再动手。

## 一、目标（一句话）

把小精灵页（`PixiePage`）右侧那块**固定 30% 的裸面板**，改造成一个**可展开/折叠的「随行面板」**，
并把面板内的**委派任务区域**按新设计的视觉语言重做（可折叠分组 + 一行汇总）。

## 二、硬约束（务必遵守）

1. **不要动左侧消息区域。** `PixiePage.tsx` 里对话区（转写 / `Composer` / `SessionStatsPills` /
   `InlineExtensionUiRequest` / `SubagentConversation` / `awaitingDispatch` 改道 `pixie.reply` 那套）
   一行都不要改。
2. **不要删除或改动「自动化」和「方寸间」两个页面。** 本阶段它们**必须原样保留**：
   - `features/automation/SchedulePage.tsx`、`features/automation/ScheduleAgentPage.tsx`
   - `features/memo/MemoPage.tsx`
   - 侧栏入口 `components/Sidebar.tsx:522-567`（automation / memo 两个 nav-item）
   - `lib/stores/app-store.ts:75` 的 `NavPage`（`"automation" | "automation-agent" | "memo"` 全部保留）
   本次**不做合并、不做删除、不改它们的入口**。它们将来会被并进小精灵，但不是这一步。
3. **不要动协议层与宿主。** `packages/pi-host/**`、`packages/protocol/**`、`pixie.ensureCurrent` /
   `pixie.dispatch` / `pixie.reply` 等端点契约一律不动。这是纯前端改造。
4. **不要动委派面板的数据与行为。** 轮询（`DISPATCH_POLL_IDLE_MS` / `DISPATCH_POLL_ACTIVE_MS`）、
   `refreshDispatches`、`PixieTaskTree` 的跳转（`jumpToPixieSession`）、会话存活态标记
   （已删除 / 已归档）全部保留。本次只改**外观与折叠**。
5. 文案一律走 i18n（`lib/i18n/zh.ts` + `en.ts`），不要硬编码中文。

## 三、现状

### 3.1 要改的就是这一段

`apps/desktop/src/features/pixie/PixiePage.tsx` 第 331–340 行：

```tsx
{/* Delegation panel (30%)：「工作区 · 会话 → 任务」两层，只有短名 + 四态；
 * 唯一的动作是行尾定位按钮，把用户送回会话里的锚点消息。 */}
<div className="hidden min-h-0 flex-col border-l border-border @3xl:flex @3xl:w-[30%]">
  <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted">
    {t("pixieDispatchPanelTitle")}
  </div>
  <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto p-3">
    <PixieTaskTree groups={taskTree} />
  </div>
</div>
```

外层的 `@3xl:flex-row` 容器（第 292 行）与左列 `@3xl:flex-[7]`（第 294 行）**不要改**，
你只处理右列这一个 div。

### 3.2 面板内容的来源

- `taskTree` 来自 `usePixieViewStore`（`features/pixie/pixie-store.ts`），类型 `PixieTaskTreeWorkspace[]`
  （`@piabyss/protocol`）。
- 渲染组件 `features/pixie/PixieTaskTree.tsx`：`工作区 · 会话 → 任务` 两层树，
  四态（排队 / 进行中 / 等你回复 / 已完成 / 失败）+ 相对时间，行尾一个定位按钮。
- 空态文案 `pixieDispatchEmpty`（「暂无委派任务」）。

## 四、目标形态

### 4.1 面板：可展开 / 折叠

**参照普通工作区会话的右侧面板（RightDock）实现**，机制如下，请保持一致的手感：

- 参考文件：`apps/desktop/src/components/RightDock.tsx`
- 折叠不是卸载，而是**负 margin 滑出**（宽度保留，动画流畅）：
  ```tsx
  <aside
    style={{ width: dockWidth, marginRight: dockOpen ? 0 : -dockWidth }}
    className={`relative flex shrink-0 flex-col border-l border-border bg-surface ${
      resizing ? "transition-none" : "transition-[margin-right] duration-200 ease-out"
    }`}
  >
  ```
  （`RightDock.tsx:516-525`）
- 开关按钮参考 `apps/desktop/src/components/DockToggleButton.tsx`：
  用 `PanelRightClose` / `PanelRightOpen`（lucide）两个图标，带 `aria-expanded` + `aria-controls`。
- **开关按钮的位置**：放到顶栏右侧，跟 chat 页的 dock 开关同一位置。
  现在 `apps/desktop/src/components/AppTopBar.tsx:279` 是：
  ```tsx
  {page === "chat" && <DockToggleButton />}
  ```
  在小精灵页加一个同位置、同尺寸（`size-7`）的开关，例如 `{page === "pixie" && <PixiePanelToggleButton />}`。
  **不要复用 `DockToggleButton`** —— 那个管的是工作区 dock（文件/终端/改动），与小精灵的随行面板是两回事。
- **状态放在哪里**：因为开关在 `AppTopBar`（`PixiePage` 之外），状态要放在 `AppTopBar` 能读到的
  store 里 —— 推荐跟 `dockOpen` 并排加在 `lib/stores/app-store.ts`（`dockOpen` / `setDockOpen`
  见 `app-store.ts:368/465/588/742/1332`），命名如 `pixiePanelOpen` / `setPixiePanelOpen`。
  也可以放 `features/pixie/pixie-store.ts`，只要 `AppTopBar` 能 import 到即可。
- **默认值**：**默认展开**（保持现在的可见性，避免进页面一片空白）；用户折叠后**记住**，
  与 `dockOpen` 一样做持久化（RightDock 用 `localStorage` key `piabyss.dock.width.v1`；
  你也可以用项目既有的 `lib/sidebar-prefs.ts` 的 `sidebarPref/setSidebarPref`）。
- **断点行为**：保留现有的 `@3xl` 断点 —— 容器窄于 `@3xl` 时右栏不显示（手动开关不生效，
  开关按钮此时应当隐藏或置灰）。手动开关只决定「够宽时是否展开」。
- **可选增强（不做也行）**：宽度可拖拽 + 持久化。若要，直接照抄 `RightDock.tsx:526-576` 的
  resize handle（左侧 2px 宽 `cursor-col-resize`、`setPointerCapture`、方向键 ±20、
  `clampDockWidth` 的钳制思路）。不做的话保持 `@3xl:w-[30%]` 即可。

### 4.2 面板内：委派任务区域按新设计重做

设计稿：**`docs/design/pixie-merge-C.html`** —— 请直接打开这个 HTML 对照视觉（右下角
「设计标注」按钮可打开说明面板）。该稿里的「委派任务」折叠分组就是目标形态。

**结构**：面板内容从「标题栏 + 列表」变成**可折叠分组（section）**：

```
┌ 随行面板 ────────────────────────────┐   ← 面板小标题（可选，见下）
│                                      │
│  ▸ ✛  委派任务   2    1 进行中 · 1 等你回复 │   ← 分组头（默认折叠）
│                                      │
└──────────────────────────────────────┘
   展开后 ↓
│  ▾ ✛  委派任务   2    1 进行中 · 1 等你回复 │
│    ▸ okxbot · 修复登录态串号        1   ⊕ │   ← 现有两层树，原样保留
│      ● 定位串号根因并出补丁   进行中  12 分钟前 │
│    ▸ 文案库 · 生成宣传文案          1   ⊕ │
│      ● 三版标题各写 5 条    等你回复  34 分钟前 │
│    行尾按钮把用户送回那条会话；插话、叫停、重试都在会话里说。 │
```

**分组头的规格**（对齐 `pixie-merge-C.html` 里的 `.sec-head`）：

- 一行：折叠箭头（展开时 `rotate-90`，`transition-transform`）+ 图标 + 标题 + 计数徽章 + 右侧汇总 hint
- 标题：`text-xs font-semibold`（12px）
- 计数徽章：`bg-surface-overlay rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums text-muted`
- 右侧汇总 hint：`text-[10.5px] text-muted`，内容形如 **「1 进行中 · 1 等你回复」**
  —— 折叠时这一行就是全部信息，所以要**在折叠态可读**；没有活动委派时显示计数 0 或空态文案
- **默认折叠**（委派列表不常打开）；折叠状态持久化（`sidebarPref`，与
  `features/automation/SchedulePage.tsx:366-377` 的分组折叠同一套写法）
- 展开后渲染**现有的 `<PixieTaskTree groups={taskTree} />`**，不要再改它的内部逻辑
- 分组容器：`border border-border rounded-xl overflow-hidden`（用项目既有 token，不要新造色值）

**面板顶部的小标题**：设计稿里是「随行面板」（`text-[11.5px] text-muted`，左侧一个 panel 图标）。
可以保留、也可以去掉 —— 保留的好处是将来「待办 · 方寸间」「自动化」两个分组并进来时有个共同容器。

**注意**：本次**只实现「委派任务」这一个分组**。设计稿里的「待办 · 方寸间」「自动化」两个分组
**本次不做**（自动化与方寸间页面要原样保留）。但容器结构请按「能再塞两个分组」来设计。

## 五、i18n

在 `lib/i18n/zh.ts` 和 `en.ts` 的 pixie 段（zh 约在 1941-1971 行）新增，例如：

| key | zh | en |
|---|---|---|
| `pixiePanelTitle` | 随行面板 | Side panel |
| `pixiePanelCollapse` | 收起面板 | Collapse panel |
| `pixiePanelExpand` | 展开面板 | Expand panel |
| `pixieDispatchSummaryRunning` | {running} 进行中 | {running} running |
| `pixieDispatchSummaryAwaiting` | {awaiting} 等你回复 | {awaiting} awaiting you |

汇总行拼装示例：`1 进行中 · 1 等你回复`；两者都为 0 时不显示 hint，只留计数徽章。

复用既有 key：`pixieDispatchPanelTitle`（「委派任务」）、`pixieDispatchEmpty`（「暂无委派任务」）、
`pixieTaskRunning` / `pixieTaskAwaiting` / `pixieTaskDone` / `pixieTaskFailed` / `pixieTaskQueued`。

## 六、测试

现有测试需要跟着改，不要删：

- `features/pixie/PixiePage.acquire.dom.test.tsx`
- `features/pixie/PixieTaskTree.dom.test.tsx`
- `features/pixie/PixieTopBarButtons.dom.test.tsx`

至少补上：

1. 默认展开；点顶栏开关后右栏折叠（`margin-right` 变为负值 / 面板不可见）。
2. 折叠状态在重新挂载后保持。
3. 委派分组默认折叠，点分组头后展开并渲染出 `PixieTaskTree`。
4. 汇总行在有 1 个进行中 + 1 个等你回复时显示「1 进行中 · 1 等你回复」。
5. 窄容器（`@3xl` 以下）下面板不占位、开关按钮隐藏或置灰。

跑 `pnpm -w test`（或仓库里既有的测试脚本）确认全绿；`pnpm -w lint` / `tsc` 也要过。

## 七、验收标准

- [ ] 左栏对话区**零改动**（`git diff` 里不应出现转写 / Composer / 轮询相关行）。
- [ ] `SchedulePage` / `ScheduleAgentPage` / `MemoPage` 与侧栏的 automation / memo 入口**全部还在**，能正常打开。
- [ ] 小精灵页右栏可以展开 / 折叠，动画与 chat 页的右侧 dock 手感一致（200ms，负 margin 滑出）。
- [ ] 折叠状态持久化，重进页面保持。
- [ ] 委派任务分组默认折叠，只占一行，汇总信息（N 进行中 · N 等你回复）在折叠态就能读到。
- [ ] 展开后是原来的两层任务树，跳转按钮、存活态标记、空态文案行为不变。
- [ ] 窄容器下不占位、不报错。
- [ ] 无硬编码中文；新增文案 zh / en 双语齐全。
- [ ] 测试、lint、typecheck 全绿。

## 八、参考文件索引

| 用途 | 文件 |
|---|---|
| 要改的面板 | `apps/desktop/src/features/pixie/PixiePage.tsx:331-340` |
| 面板内容组件 | `apps/desktop/src/features/pixie/PixieTaskTree.tsx` |
| 面板数据 | `apps/desktop/src/features/pixie/pixie-store.ts` |
| **折叠机制参考** | `apps/desktop/src/components/RightDock.tsx:516-576` |
| **开关按钮参考** | `apps/desktop/src/components/DockToggleButton.tsx` |
| 开关按钮挂载点 | `apps/desktop/src/components/AppTopBar.tsx:277-281` |
| dock 状态 | `apps/desktop/src/lib/stores/app-store.ts:368,588,742,1332` |
| 分组折叠持久化写法 | `apps/desktop/src/features/automation/SchedulePage.tsx:366-377` + `lib/sidebar-prefs.ts` |
| **视觉设计稿** | `docs/design/pixie-merge-C.html`（「委派任务」分组） |
| 设计说明（背景） | `docs/design/pixie-merge-C.html` 右下角「设计标注」 |

## 九、背景（为什么这么做，供你判断取舍）

小精灵、方寸间、自动化三个页面最终要合并进小精灵一页：对话在左占主位，右栏是「随行面板」，
从上到下依次是「待办 · 方寸间」（常驻展开）、「自动化」（默认折叠）、「委派任务」（默认折叠）。
设计稿 `docs/design/pixie-merge-C.html` 是完整形态。

**但本次只做第一步**：把右栏从裸面板升级为可折叠的随行面板，并先把「委派任务」分组按最终视觉做好。
自动化与方寸间**这一阶段保持独立页面不动**，等后续步骤再迁。
所以你在写代码时，请把面板结构设计成「将来能再塞两个分组进来」的样子。
