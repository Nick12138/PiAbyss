# PiAbyss 产品 / UX 评估(2026-07-30)

只读评审,未修改业务代码。视角是**产品与用户体验**:UI 完成度、pi-agent 适配覆盖度、交互体验。与 [2026-07-27 独立代码 Review](./2026-07-27-independent-review.md)(可靠性视角)互补,不重复其发现。

## 评审方式与覆盖声明

- 三条并行深读通道:① 桌面 UI 盘点(界面清单/设计系统/状态完备性/i18n/a11y);② SDK 适配矩阵(以 `packages/pi-host/node_modules/@earendil-works/pi-coding-agent/dist` 实际导出为准,对照 pi-host 接线与前端消费);③ 六大交互场景(聊天主流程/输入/会话流转/中断恢复/首启/周边)。合计通读或定点核查约 200 个源文件,关键论断均带 `path:line` 锚点。
- 另读:`docs/architecture/*`、`docs/operations/*`、`docs/history/2026-07-27-independent-review.md`、`.planning/` 中 session-switch-lag、session-open-scroll、transcript-outline、git-changes-implementation、pi-sdk-0.82.1-review 等设计记录。
- **口径**:全部结论来自静态代码走读与仓库记录,未实际运行应用。个别条目标注「待运行时复现」。
- 基线:HEAD `a1a305e`,SDK 钉 `0.82.1`(上游 2026-07-29 已发 `0.83.0`,发布节奏约每周一发)。

## 总体评价

**引擎是产品级的,驾驶舱差最后一公里。**协议层、Host 状态机、流式渲染管线、恢复循环这些"难而不可见"的部分,质量明显高于同类早期项目(1200+ 测试、机器生成的协议覆盖、07-27 评审 34 条发现已按 `.planning/` 逐条整改)。"易而可见"的部分——首启引导、中断可达性、快捷键、切换反馈——存在一批**低成本高影响**的缺口,其中两个会直接阻断新用户。

当前状态适合"作者本人 + 少数早期用户从源码运行";距离"给生人安装"还差一轮集中的体验收尾,而这一轮的工作量远小于已完成的部分:置顶几项都是一行到几十行的修复。

进度基本盘:194 个提交(主体 2026-07-18 起 12 天);桌面 UI 约 2.65 万行(chat 特性独占 8,700 行)+ pi-host 约 2 万行(测试 1:1 配比)+ 协议 5,400 行 + Rust 4,300 行。发布面:Windows 有未签名 NSIS 候选 + 签名更新器通道;macOS 仅 `tauri:dev` 源码运行,不能打包(见 [release.md](../operations/release.md))。

成熟度分层(主观评估):

| 层面 | 成熟度 | 一句话 |
|---|---|---|
| 核心会话引擎(流式/恢复/队列/压缩/树) | ≈ 产品级 | 难点全做对,且有测试与 planning 记录背书 |
| 生态面(Provider / Package / 扩展 UI) | ≈ 产品级,带 3 个静默失效洞 | 深度超出"套壳",洞见下文适配度节 |
| 交互最后一公里 | ≈ 60% | Stop 可达性、steering、输入框、切换反馈等小改集中欠账 |
| 首启漏斗 | ≈ 40% | 两个硬阻断(死锁 + 无凭据死循环) |
| 分发 | ≈ 30% | Windows 未签名、macOS 未打包 |

---

## 一、UI:骨架完整,组件层与空态是短板

技术底座:React 19 + Zustand 5 + Tailwind v4,无第三方组件库,全部控件手写;无路由库,导航靠 `NavPage` 状态(`apps/desktop/src/lib/stores/app-store.ts:40`)。

### 界面清单(均为完整实现,非骨架)

聊天(Composer 1,644 行 + Transcript 1,371 行)、侧栏 + 会话列表(1,328 行:搜索/置顶/归档/重命名/清理/状态点)、工作区选择、设置覆盖层五分区、Provider/模型管理(2,300+ 行,含 OAuth 与模型目录抓取)、Package 管理(1,288 行)、右侧 Dock(文件树/会话树/Git Changes/浏览器×8/终端)、扩展 UI 三形态(modal / inline / dock 虚拟终端)、通知中心、更新器、启动屏(6 阶段状态机)、平台原生窗口控件。

**结构性缺失**:无命令面板;`NavPage` 的 `"packages"` 值是死代码——全仓 `setPage(` 仅 3 处且均不传它,Packages 页只能从 Settings 侧栏进入。

### 做得好的(恰在中文用户最敏感处)

1. **i18n 是真工程**:`lib/i18n/` 双语字典各 887 键,`zh.ts:4` 用 `Record<MessageKey, string>` 让缺键变编译错误,运行时另有非空校验;全仓 1,036 处 `t("` 调用;中文是人工翻译质量。
2. **CJK 排版讲究**:自带 PingFang SC 三字重 woff2,`styles/index.css:5-36` 用 `unicode-range` 精确限定 CJK 区段,拉丁字符不被中文字体接管;配合 `@streamdown/cjk`。
3. **IME 竞态修复**:`lib/use-ime-composition.ts` 针对 WebKit `compositionend`/`keydown` 顺序问题做 30ms 宽限窗 + keyCode 229 兜底——直接解决"拼音候选态按回车误发送"。
4. **主题启动零白闪**:`bootstrap-theme.ts` 在 React 之前落 class(`index.html:136`);reduced-motion 全局兜底(`styles/index.css:330-339`)。
5. **Settings 系三态完整**:`ProvidersSettings.tsx:1002-1045` 与 `PackagesPage.tsx:1088-1123` 做到 loading / error+重试 / 空态区分"筛选空"与"真空" / 一键清筛选;包安装进度含 15 秒无事件的"仍在等待"提示。
6. ARIA 用量真实(256 个 `aria-*`,tree/tablist/menu/progressbar/separator 语义齐);Dialog 与 ExtensionUiModal 各有完整焦点陷阱。

### 薄弱的

1. **无全局快捷键**:全仓 keydown 监听几乎只处理 Escape 关浮层;Rust 侧无菜单 accelerator。Cmd+N / Cmd+, / Cmd+K / Cmd+F 全缺。
2. **零会话空态缺失**:`SessionList.tsx:1273` 只覆盖"筛选无结果";工作区就绪但无会话时只剩孤零零的 "Recent" 标题。全应用零 skeleton,loading 一律转圈。
3. **设计系统只有色彩层没有组件层**:共享抽象仅 Dialog/Switch/SectionHeader/PiMark;`buttonBase` 等 3 个字符串常量是全部共享样式;已出现 4 处硬编码 hex 逃逸主题(`CodingToolCards.tsx:208-210`、`ToolCard.tsx:235`),浅色模式下不跟随。
4. **模态行为不统一**:两套焦点陷阱实现;ForkModal / SessionStatsModal 无陷阱无焦点还原;7 处独立 Escape 监听靠 `defaultPrevented` 约定协调,无 overlay stack。
5. **Pi 主题包对 GUI 零影响**:协议与 Host 均支持 theme 资源(`packages/protocol/src/types.ts:472`),桌面端只做计数展示——用户装了主题包看不到任何变化(SDK 主题本质是 ANSI 调色板,"不映射"可以是合理决策,但需要在 UI 里说明,而不是静默无效)。
6. tooltip 全用原生 `title=`(100+ 处);硬编码英文残留:Host 不可用整块(`App.tsx:978-985`)、错误边界(`main.tsx:51-67`)、WindowControls aria-label、8 条通知模板。

---

## 二、pi-agent 适配度:深度超出"套壳",带三个静默失效的洞

### 覆盖矩阵摘要

先划界:MCP、subagents、工具权限弹窗、plan mode、todo 是 **SDK 明文非目标**(SDK `docs/usage.md`),不计为 PiAbyss 缺口。

| 能力域 | 状态 |
|---|---|
| 24 种会话事件 | ✅ 全量白名单化(`pi-host/src/event-normalize.ts:5-33`),未知事件收敛为 `unknown`;`bash_execution_update` 有意跳过且有书面理由与回归测试 |
| prompt / steer / followUp / abort / 队列 | ✅ Host 全通;队列**超出 SDK**(可重排/编辑/runNow,`queue-attachments.ts` 侧表补回 SDK 会丢的图片)。⚠️ 前端从不调 steer(见交互节) |
| 压缩 / 上下文 | ✅ 手动+自动+中断+用量环;分项估算(`context-usage-breakdown.ts`)**超出 SDK**。分支摘要有意跳过(`navigateTree` 硬编码 `summarize:false`) |
| 会话树 / fork / 导出 | ✅ 泳道图、before/at 双位置 fork、HTML/JSONL 导出;归档/置顶/清理**超出 SDK** |
| 模型 / thinking / 认证 | ✅ ModelRuntime 单例注入、自建 CredentialStore(0.82.1 移除 AuthStorage 后按公开契约重实现,含跨进程文件锁)、OAuth 桥接、thinking 能力探测目录(30 条正则)**超出 SDK** |
| Provider 管理 | ✅ 事务日志(journal)**超出 SDK**;自定义 provider 全 CRUD **超出 CLI** |
| Packages / 资源 | ✅ 全生命周期 + 逐资源启停 + 作用域遮蔽关系;隐式安装抑制(`withoutImplicitPackageInstall`)**超出 SDK** |
| Skills / Prompts / 斜杠命令 | ✅ 汇入 `session.getCommands` + 5 个内置命令;⚠️ 无 skill 浏览器/SKILL.md 查看器 |
| 附件 | ✅ 图片 + **纯自建**的文档附件管线(PDF/DOCX 解析 + `read_attachment` 自定义工具 + 超长粘贴转附件) |
| 扩展 UI | ✅ 全仓最深适配(见下);TUI 专有 API(15 个)全部显式 no-op,有意跳过 |
| Settings | ⚠️ 48 键只暴露 5 个(`settings-controller.ts:78-105`);`httpProxy`、`compaction` 阈值、`retry` 预算、`sessionDir` 均不可配 |
| 工具面板 | ⚠️ `agent.getTools/setActiveTools` 协议与 Host 全通,**前端零消费**——"禁掉 bash 做只读会话"做不到 |

### 适配深度的三个标志

1. **虚拟终端**(`pi-host/src/virtual-terminal.ts`):在 Host 进程里跑**真实 pi-tui**,ANSI 流经 `extensionUi.customFrame` 推给前端 xterm.js,键盘反向回灌,连 OSC 11 背景色探针都由真 xterm 回包。TUI 时代的 `ui.custom()` 扩展面板因此在 GUI 可用——全仓技术含量最高的适配。
2. **SDK 补丁克制且有原则**:唯一补丁 `patches/@earendil-works__pi-coding-agent@0.82.1.patch`(584 行,8 文件,全打 dist、每处带 `// PiAbyss patch:` 注释):包子进程取消(`.d.ts` 声明为必需方法,漏接线=编译错误)、`invocationRunner` 可信调用上下文(11 条事件路径逐一包裹,扩展弹窗从此有来源)、`piabyss` 命名空间类型、`package.update` 作用域。SHA 钉进 `scripts/release-runtime.lock.json`;上一版的 `preserveExtensionCache` 行为补丁被**主动删除**改走官方路径。决策全记录在 [pi-sdk-0.82.1-api-notes.md](../operations/pi-sdk-0.82.1-api-notes.md)。
3. **修了 SDK 的真实泄漏**:`ModelRuntime` 进程级 provider 注册在多工作区 Host 下会跨区泄漏 apiKey;`extension-provider-ownership.ts` 用 AsyncLocalStorage 归属窗口 + 引用计数 + suspend/resume 建隔离层,且**先写复现测试再动手**。

### 最重要的缺口(按对用户的实际影响排序)

1. **`bindExtensions` 未传 `commandContextActions`**(`extension-ui-bridge.ts:1124-1128`):SDK 缺省实现返回 `{cancelled:false}` 什么都不做 → 扩展里的 `ctx.newSession()/fork()/navigateTree()/switchSession()/reload()` **点了"成功"但无任何效果、无报错**。SDK 官方示例(handoff、git-checkpoint、bookmark)全依赖这些;PiAbyss 自身有全部对应实现,接线成本不高。
2. **未传 `onError`**(`ExtensionErrorListener`,全仓 `ExtensionError` 零命中):扩展 handler 在 agent 轮次中抛错,用户看不到任何提示。与 ① 叠加,扩展调试体验为零——对"把 pi 扩展生态搬进 GUI"这一核心卖点是信任级伤害。
3. **`projectTrusted` 硬编码 `true`**(`workspace-lifecycle.ts:711`):打开任意仓库即加载执行其 `.pi/` 扩展。这是文档化的产品决策("选择工作区即授权"),但与 CLI 的 `/trust` 分叉;且策略层已把 `project_trust` 列为强制 modal 高危(`extension-ui-policy.ts:53-54`)——策略准备好了,数据源没接。
4. **Settings 面 48 → 5**:`httpProxy` 不可配对企业网/国内网络用户是硬需求;压缩阈值与重试预算不可调。
5. **工具渲染只覆盖 4 类 + 无 delta 流**:`ToolView.tsx` 仅 web-search / read / shell / edit-write 有专用卡,grep/find/ls 落通用卡;`message_update` 传整条消息快照而非增量(测试注释承认是待办)——长回答时每帧重传全文,是长会话卡顿的结构性来源。两项都是纯前端/协议工作量,无 SDK 阻塞。

死通道备忘:`agent.compactionChanged` / `agent.retryChanged` 协议事件 Host 从不发射,前端处理分支收不到;`setWidget` 的 `aboveEditor` placement 被强制丢弃;session entry label 只读。

---

## 三、交互体验:流式管线一流,"最后一公里"欠账集中

### 做对了难的

- **流式渲染**:`message_update` 帧级合批(单 rAF flush,`App.tsx:633-653`),flush 前按六元组身份过滤,切会话残帧整批丢弃;`reuseStableRows` 行级复用 + memo 行组件把重渲染压到单行;`parseIncompleteMarkdown` 让未闭合语法不闪烁;词级淡入。
- **Markdown 质量**:代码块 >16 行自动折叠、portal 复制按钮、表格独立容器 + `tabular-nums`、Mermaid 消毒(剥 script/animate/foreignObject)+ 失败卡 + 重试、KaTeX、脚注 per-message 前缀、渲染崩溃降级纯文本;外链走 Dock 浏览器,Cmd/中键走系统浏览器。
- **滚动跟随**:80px 阈值判 following;用户一滚离底部立即取消待执行滚动帧(不劫持阅读);只有显式"跳到最新"用 smooth;有 DOM 回归测试。
- **附件管线**:超长粘贴自动转附件且可一键还原(失败自动插回原文);PDF/DOCX 带进度/重试/错误语义映射;Tauri 拖放拿真实路径。
- **切换竞态**:`LatestSessionOpenQueue` 串行化但只保留最新意图(连点三个会话中间那个不执行);`SERVICE_GRAPH_BUSY` 五次退避;恢复期清空排队意图防跨 epoch。
- **恢复机制**:序号 gap/身份不匹配主动触发 recovery;`RecoveryEventBuffer` 按 watermark 回放;`hello → setCurrent → fullRehydrate → 恢复会话 → 再 rehydrate` 五次退避;`SESSION_NOT_FOUND`/`STALE_REVISION` 各有正确语义;HostClient 防旧 epoch 迟到 fatal。
- `.planning/session-switch-lag/` 的排查记录(假设被用户反馈推翻 → 实测 502-540ms → 定位到 SDK reload 用 Jiti 重编译全部扩展包 → 两轮修复)体现了真实的工程纪律。

### 被低成本问题拖住(合并三路调查,按影响排序)

| # | 问题 | 证据 | 修复成本 |
|---|---|---|---|
| 1 | **恢复失败 → 启动屏永久卡死**:rehydrate 5 次全败后 `desynchronized` 不复位,`startupSettled` 恒 false,启动屏永远"正在重新连接",底下整个 UI 被 `pointer-events-none` + `aria-hidden` 封死,只能强杀进程。〔待运行时复现,机制静态可追〕 | `App.tsx:530-531`(条件)、`:141`(置位)、`:819-824`(失败分支漏复位) | 一行 |
| 2 | **无凭据首启是死循环**:`AUTH_REQUIRED` 横幅是死代码(pi-host 零产出,仅 `ChatPage.tsx:16-18` 消费);`agent.prompt` 返回 `accepted:true` 无预检,失败在 detached 任务里才暴露;SDK 错误文案指引用户输入 `/login`——而 PiAbyss 内置命令只有 5 个,`/login` 被当普通 prompt 发给不存在的模型,再收到同一句报错;且多行诊断被压成一行(`Transcript.tsx:429` 缺 `whitespace-pre-wrap`)。Rust 不 `env_clear()`,开发者的 `ANTHROPIC_API_KEY` 等环境变量旁路掩盖了整条路径("在我机器上是好的") | `builtin-commands.ts:9-31`、`agent-controller.ts:278-389`、`pi_host.rs:1028-1063` | 现成探针 `provider.authStatus`(`provider-controller.ts:1844`)前端未用,接上即可做发送前引导 |
| 3 | **有草稿时无法中断**:busy + 草稿非空 → Stop 按钮被"加入队列"替换而**消失**;无 Esc 中断。要停必须先清空正在写的内容 | `Composer.tsx:1570-1605`、`:1235-1238` | 小 |
| 4 | **无法 steering**:Host 实现了 `agent.steer`(`agent-controller.ts:391`),[chat-runtime.md](../architecture/chat-runtime.md) 也声称 busy 时用它,前端从不调用;QueuePanel 能展示/删除 steering 项却无创建入口。"跑偏了插一句纠正"只能整轮 abort | `Composer.tsx:1177-1189` | 小 |
| 5 | **输入框**:固定 60px 不自动增高(`resize-none`,写 20 行需求在 3 行高的框里滚)、启动/切换/新建均不自动聚焦、草稿仅内存重启即失;发送无乐观回显,新会话首条消息在 `agent_start` 前像凭空消失 | `Composer.tsx:1483`、`ChatPage.tsx:22-24` | 小 |
| 6 | **thinking 被双层折叠埋没**:凡调了工具的轮次(即绝大多数),thinking 被并入默认折叠的 ExecutionTrace,等待期屏幕只有"运行中 N 步" | `Transcript.tsx:598-615`、`:657` | 中 |
| 7 | **切换零反馈**:会话/工作区切换期间目标行无任何进行中指示(spinner 曾实现、被要求移除,但残余延迟没有替代反馈方案);工作区切换超时 60s 期间同样无反馈 | `SessionList.tsx:1082-1087`、`WorkspacePicker.tsx:94-142` | 小 |
| 8 | **Windows 终端无法键盘复制粘贴**:xterm 只装 fit addon,Ctrl+C/V 被转义为控制字符,也无 Ctrl+Shift+C/V——而 `tauri.conf.json:33` 的 NSIS 是当前唯一发布产物(macOS 因 Cmd 不被拦截才正常) | `XtermSurface.tsx` 依赖面 | 小 |

### 周边面板:同一模式——骨架好、收尾欠

- **Git Changes**(范围是 planning 里主动收窄的,合理):订阅式刷新(`git.changed` 推送非轮询)、错误码语义映射、STALE_REVISION 自动重拉、冲突禁提交都对;但**无批量暂存**(50 个改动=50 次点击+50 次串行 RPC)、agent 一改文件就把用户正读的 diff 强关(`ChangesPanel.tsx:163-169`)、diff 无语法高亮/词级对比、展示 ahead/behind 却无 push/pull(死胡同指示器)。
- **终端**:输入 8ms 合批 + 64KB 分片不切代理对、主题实时跟随都好;但关闭运行中终端无确认、"重启"换 key 重挂载丢全部 scrollback、数量无上限(浏览器有 8 个上限)、Dock 折叠后终端仍可持焦点吃键入。
- **扩展弹窗**:决策组语义(连续问题复用同一卡壳、刻意不存答案文本)、≥12 选项出搜索、≥100 虚拟化都很细;但**跨会话 candidate 请求会抢占前台且弹窗不显示来源会话**(`event-identity.ts:76-80` + `ExtensionUiModal.tsx:10-11` 无会话过滤);Inline 面无 Escape 取消(Modal 有);原生浏览器子 webview 永远盖在所有 HTML 模态之上(`browser_surface.rs:145,179`),规避只做了 Dock 自身菜单。
- **更新器**:链路通、封装干净;但无下载进度(`downloadAndInstall()` 无参调用,Started/Progress 事件全没接)、无更新日志(丢弃 Tauri `Update.body`)、装完不确认直接 `relaunch()`(杀掉全部终端与未发草稿;对比"重启 Host"反而有确认框)、只在启动时检查一次。
- **长会话**:无虚拟化,策略是"尾部 60 行窗口 + content-visibility + 展开锚点补偿";已知天花板(任意向前跳转、滚动位置持久化)在 `.planning/transcript-outline/` 明确记录并**主动推迟**——中等会话够用,是清醒的债而非盲区。
- 无重新生成、无编辑重发、无 transcript 内查找;消息级操作只有复制与 fork。

---

## 四、建议:一轮体验收尾冲刺

如果目标是尽快让第一批外部用户用起来,建议顺序(总量远小于已投入):

1. **修两个漏斗杀手**:#1 启动死锁(一行)+ #2 无凭据引导(接 `provider.authStatus` 做发送前引导 + 拦下 `/login` 给出 GUI 指引 + 补 `whitespace-pre-wrap` + Rust `env_clear()` 消除环境分叉)。
2. **修扩展静默失效**:接线 `commandContextActions` 与 `onError`——这两个决定扩展生态在 GUI 里"可信"还是"玄学"。
3. **交互小改批量清**:#3 Stop 可达性(busy 时并排显示停止,Esc 中断)、#4 steering 接线(或改文档)、#5 输入框三件套、#7 切换反馈、#8 Windows 终端剪贴板。
4. 之后再谈 Windows 签名与 macOS 打包——在漏斗修好前,分发只会放大第一印象问题。

顺手项:README 的"macOS 揭示路径仍用 xdg-open"限制描述已过时(`commands.rs:376` 已有 macOS 分支);`chat-runtime.md` 的 steer 表述与实现不符,文档与代码需对齐一处;`SessionList.tsx:77` 的 `"新会话"` 硬编码中文兜底在英文环境下参与搜索匹配;`SessionList.tsx:510` / `WorkspacePicker.tsx:113` 残留 `console.info` 诊断日志。

## 附:本次评审与 07-27 评审的关系

07-27 评审回答"这套系统在边界条件下会不会坏"(可靠性),本次回答"用户第一天和第三十天用起来是什么感受"(产品/UX)。两者结论一致的地方是:**这个仓库最强的能力是把复杂状态机做对,最欠的能力是把简单的可见细节做完。**07-27 的 34 条已整改;本次的清单里 #1、#2 与扩展两洞属于同量级的"发版前必修",其余是体验债,可按上文顺序分批清。
