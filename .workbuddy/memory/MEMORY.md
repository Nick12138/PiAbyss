# PiAbyss 项目长期记忆

## 跨仓库结构
- **my-pi-plugins**（pi-pixie 等插件源仓库）：`C:\Users\liu\Documents\我的项目\my-pi-plugins`，与 PiAbyss 联动。`pixie_rest / pixie_dispatch / pixie_ask` 等工具的 LLM 侧 schema 在那边（`packages/pi-pixie/src/pixie-tools.ts`）；Host 侧控制面/校验在 PiAbyss `packages/pi-host`。改工具参数要**两仓库同步改**。
- my-pi-plugins 不用 prettier（tab 缩进，默认 prettier 全仓库报 warn，属正常）；PiAbyss 用 prettier + 2 空格。

## pi-host 预存问题（未修，勿误判为新错）
- `packages/pi-host/src/pixie-controller.ts` 有 6 个 unused-vars lint 错误（HEAD 即有）。
- 改 protocol 或 pi-host 后必须先 `npm run build`（dist 类型），desktop typecheck 才不报旧类型错。

## 小精灵会话模型（v5）
- 打盹 = 旧段按 `segmentSessionName(title>handoff>phrase)` 归档命名 + 新建无名会话接任指针；段名**只在打盹时定**，新建不命名（2026-10-13 Nick 拍板）。
- pixie 会话被 `isPixieWorkspaceCwd` 从 agent-controller 的"首条消息自动起名 + LLM 精修"路径摘除。
- 顶栏三件套：PixieBackToCurrentButton（打开历史段时出现，ensureCurrent→切回活段，无活段兜底新建）/ PixieSessionsButton（点击浮层）/ PixieNapButton（空会话禁用）。
