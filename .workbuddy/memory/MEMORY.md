# PiAbyss 项目长期记忆

## 跨仓库结构
- **my-pi-plugins**（pi-pixie 等插件源仓库）：`C:\Users\liu\Documents\我的项目\my-pi-plugins`，与 PiAbyss 联动。`pixie_rest / pixie_dispatch / pixie_ask` 等工具的 LLM 侧 schema 在那边（`packages/pi-pixie/src/pixie-tools.ts`）；Host 侧控制面/校验在 PiAbyss `packages/pi-host`。改工具参数要**两仓库同步改**。
- my-pi-plugins 不用 prettier（tab 缩进，默认 prettier 全仓库报 warn，属正常）；PiAbyss 用 prettier + 2 空格。

## pi-host 预存问题（未修，勿误判为新错）
- `packages/pi-host/src/pixie-controller.ts` 有 6 个 unused-vars lint 错误（HEAD 即有）。
- `packages/protocol/src/dto-validate.ts` 有 3 个 unused-vars lint 错误：`isSessionStatsSnapshot`(≈1102)、`isSessionContextUsage`(≈1152)、`isPixieModelSelection`(≈1164)（HEAD 即有）。
- 改 protocol 或 pi-host 后必须先 `npm run build`（dist 类型），desktop typecheck 才不报旧类型错。
- pi-host 全量 `vitest run` 在本机不稳定：`git-async-tasks` / `git-service` / package+workspace integration 会以 `spawnSync git EBUSY` 失败，随后 tinypool 抛 `ERR_IPC_CHANNEL_CLOSED` 导致没有汇总输出。属环境问题，验证改动请**按文件定向跑**。
- desktop 全量 `vitest run` 也曾跑到 14 分钟无输出被 kill（同属本机环境/资源问题，非代码）；稳妥做法是 `npx vitest run src/features/<目录>` 定向跑，本次提问卡片改动用 `src/features/chat src/features/pixie`（49 文件 494 项）+ i18n 相关 5 个文件覆盖。

## ask_user_question 提问卡片（2026-10-14 改版）
- 涉及文件：`apps/desktop/src/features/chat/{ExtensionUiRequestContent,InlineExtensionUiRequest,ExtensionUiModal}.tsx`、`use-extension-ui-response.ts`、`lib/i18n/{zh,en}.ts`；插件侧 `my-pi-plugins/packages/pi-ask-user-question`。
- **跨进程契约（勿改）**：插件在 `ui.select` 的 values 末尾追加哨兵行，桌面按**标签前缀**识别 ——
  - `Type something.` 等自由输入哨兵：桌面在 `allowFreeform === true` 时**吸收**它（不再渲染成选项），避免与卡片自带的自由输入框形成双入口；`allowFreeform` 缺失时保留为普通选项（兼容其他 host）。
  - `↩ …` 前缀 = **回退动作**（`BACK_ROW_LABEL`，插件 `src/constants.ts`）。桌面把它从选项列表摘出，渲染成卡片底部的「修改上一题」按钮，点击时把该标签原样作为 `respond` 的值回传。前缀字符是契约，后缀文案可本地化。
- **回滚只能做在插件侧**：宿主与插件之间只有 `ui.select` / `ui.input` 的单向返回值，协议没有"撤销上次作答"的方法；答案一旦 return 就交给模型了。所以 `runQuestionnaire` 改成可回退状态机（`answers` / `rawValues` 数组 + `questionIndex` 可减），而不是在桌面假装回滚。
- 新增的 piabyss 元数据（插件 → 宿主 → 桌面）：`questionIndex` / `questionCount` / `questionHeader` / `defaultValue`。桌面据此画题号 chip、header chip，并在回退重问时**恢复**上次答案。
- **`defaultValue` 的预填责任分层（2026-10-14 晚定，勿再混用）**：它的值是"上次的**原始作答串**"，可能是**位置串**（多选 `"1,3"`、单选 option id）也可能是**自由文本**——**只有拿到选项表的卡片能分辨二者**（`ExtensionUiRequestContent.tsx` 的 `parsePositionList`）。所以：
  - 带选项表的请求（`kind === "select"` 或 `multiSelect === true`）由**卡片层**决定输入框初值：位置串 → 落在勾选、输入框置空；否则 → `setInput(defaultValue)`；换题时同一 effect 负责清空，杜绝串题。
  - `use-extension-ui-response.ts` 对这类请求**直接 return，不碰输入框**，只负责普通 `input` / `editor` 的 seed。
  - **踩过的坑**：hook 曾对所有 `multiSelect` 一刀切 `setInput("")`，而 React passive effect **子先父后** → 卡片刚恢复的自由文本被父层紧跟着抹掉，回退重问时输入框为空（症状 3，2026-10-14 修）。改这块必须同时看这两处 effect。
- 交互语义变更：**单击选项 = 选中，确认按钮/Enter 才提交**（此前点击即提交、误点不可撤）。双击选项 = 直接提交。
- 来源行（"来自 X"）只在**非**内置问卷的扩展请求上显示：`ask_user_question` 永远来自同一个插件，每题都印一遍是噪音（Nick 2026-10-14 拍板）。`Transcript.tsx` 里扩展消息的来源标签不受影响。
- 插件已到 v0.3.0（`Nick12138/my-pi-plugins@469ad1e`：多选结构化下发 + 回退按 `↩` 前缀匹配）。插件经插件库以 repo 形式安装，**改 `src` 后必须同时抬 `plugins.json` 与包内 `package.json` 的 version**，否则插件库里看不到可更新（只改 `tests/` 不用抬）。

## 前端踩坑：StrictMode 双跑 × 全局单槽
- `apps/desktop/src/main.tsx` 全应用包 `<StrictMode>`：**dev 下新挂载组件的 effect 会跑两次**（生产不会）。凡是"挂载即发起一次全局副作用"的 effect，都要考虑重放：典型症状是同一 RPC 并发两次。
- `app-store.workspaceSwitchTarget` 是**驱动切换反馈 UI 的单槽**，不是取消令牌。`activateWorkspaceAcrossWorkspaces` 曾把它当"我是否被取代"的判据并 `finally` 无条件清空 → 两个同 cwd 的并发切换会互相判为"被取代"而返回 `blocked`。现已改为"只有**另一个 cwd** 才算取代；清空只在槽位仍属于自己时执行"。
- 定位这类问题的有效手段：`<StrictMode>` 包住组件 + mock `session-navigation`，数 RPC 调用次数；再用可控 promise 模拟"慢的那次最后落地"复现 UI 终态。
- 相关：`8f37c4e` 修的是**生产**版的「暂不可用」（停驻图缺前台会话位 → optimistic pending shell → `AGENT_NOT_READY`，该错误码前端不重试）；dev 版残留症状根因是上面这条，2026-10-14 已修（见当日日志）。

## 小精灵会话模型（v5）
- 打盹 = 旧段按 `segmentSessionName(title>handoff>phrase)` 归档命名 + 新建无名会话接任指针；段名**只在打盹时定**，新建不命名（2026-10-13 Nick 拍板）。
- pixie 会话被 `isPixieWorkspaceCwd` 从 agent-controller 的"首条消息自动起名 + LLM 精修"路径摘除。
- 顶栏三件套：PixieBackToCurrentButton（打开历史段时出现，ensureCurrent→切回活段，无活段兜底新建）/ PixieSessionsButton（点击浮层）/ PixieNapButton（空会话禁用）。
- **已消失的"遗留 bug"：`pixie.rundown` 每轮询 3 次重复请求**——v5（`5e91b07`，10-13 16:38）退役自管会话机制时连同 `pixie.rundown` RPC 一起删掉了（前端零调用、protocol 无此方法）。问题文档提交时（`b9e9df2`）状态就已过期，2026-10-14 Nick 拍板直接删除该文档；《小精灵功能设计.md》"已知问题"一节随之移除。统计胶囊现走标准 `session.getStats`（mount/身份变化/idle 翻转才重取，无轮询）。`session-stats.ts` 仍有 2 处提及 pixie.rundown 的过期注释待顺手清理。
