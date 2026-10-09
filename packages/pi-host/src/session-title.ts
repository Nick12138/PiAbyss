import {
  completeSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

const DEFAULT_SESSION_TITLE = "新会话";
const DEFAULT_TITLE_EMOJI = "💬";
// Total budget for the whole title. The leading emoji + separator take 2
// characters and the trailing ellipsis 1, leaving up to 15 characters for the
// title text itself.
const MAX_SESSION_TITLE_LENGTH = 18;

/**
 * Topic keyword -> emoji mapping, ordered from most to least specific.
 * Used to pick a topic-relevant emoji when the model omits one, so titles
 * stay varied instead of all defaulting to a single emoji.
 */
const TITLE_EMOJI_BY_KEYWORD: ReadonlyArray<{ pattern: RegExp; emoji: string }> = [
  // 修复与故障
  {
    pattern: /修复|bug|错误|报错|崩溃|缺陷|异常|fix|error|crash|issue|exception|throw/i,
    emoji: "🐛",
  },
  // 测试
  { pattern: /测试|用例|覆盖|spec|test|coverage/i, emoji: "🧪" },
  // 安全与认证
  {
    pattern:
      /安全|权限|登录|认证|漏洞|验证码|加密|解密|密码|密钥|哈希|auth|login|security|captcha|encrypt|token|hash/i,
    emoji: "🔒",
  },
  // 性能与并发
  { pattern: /性能|优化|提速|加速|并发|线程|perf|speed|parallel|thread/i, emoji: "⚡" },
  // 重构与清理
  { pattern: /重构|清理|简化|整理|refactor|cleanup|simplify/i, emoji: "🧹" },
  // 配置与设置
  { pattern: /配置|设置|选项|参数|环境变量|config|settings|option|env/i, emoji: "⚙️" },
  // 界面与样式
  {
    pattern:
      /界面|样式|布局|组件|皮肤|主题|外观|深色|暗色|浅色|ui|design|style|css|tailwind|component|widget|theme|dark|light/i,
    emoji: "🎨",
  },
  // 数据库与存储
  { pattern: /数据库|存储|缓存|数据|内存|泄漏|db|sql|cache|storage|memory|leak/i, emoji: "🗄️" },
  // 网络与服务
  {
    pattern:
      /网络|请求|接口|服务|远程|代理|在线|离线|套接字|api|http|server|proxy|socket|network|online|offline/i,
    emoji: "🌐",
  },
  // Git 与版本控制
  {
    pattern: /git|提交|分支|合并|仓库|回滚|版本控制|commit|branch|merge|rebase|github|vcs/i,
    emoji: "🌿",
  },
  // 构建与发布
  {
    pattern: /构建|编译|打包|发布|部署|上线|交付|build|compile|bundle|deploy|release/i,
    emoji: "🚀",
  },
  // 文档与说明
  {
    pattern: /文档|注释|说明|手册|教程|readme|\bdoc(?:s|x)?\b|comment|guide|tutorial/i,
    emoji: "📝",
  },
  // 文件与路径
  { pattern: /文件|目录|路径|资源|folder|file|path|fs|asset/i, emoji: "📁" },
  // 依赖与模块
  { pattern: /依赖|安装|模块|依赖项|install|package|module|dependency/i, emoji: "📦" },
  // 升级与迁移
  { pattern: /升级|更新|迁移|同步|upgrade|update|migrate|migration|sync/i, emoji: "🔄" },
  // 搜索
  { pattern: /搜索|查找|查询|过滤|筛选|search|find|query|filter/i, emoji: "🔍" },
  // 会话与聊天
  { pattern: /会话|聊天|对话|消息|提示词|chat|session|prompt|message/i, emoji: "💬" },
  // 工作区
  { pattern: /工作区|workspace/i, emoji: "💼" },
  // 调试与日志
  { pattern: /调试|日志|排查|定位|追踪|debug|\blog(?:s)?\b|trace/i, emoji: "🧩" },
  // 校验与格式化
  {
    pattern: /校验|验证|断言|格式化|规范|风格|validate|validation|schema|assert|format|lint/i,
    emoji: "✅",
  },
  // 插件与扩展
  { pattern: /插件|扩展|市场|plugin|extension|addon|marketplace/i, emoji: "🔌" },
  // 容器
  { pattern: /容器|镜像|编排|docker|container|image|k8s|kubernetes/i, emoji: "🐳" },
  // 持续集成
  { pattern: /持续集成|流水线|ci|pipeline|workflow|github action/i, emoji: "🤖" },
  // 桌面与系统
  { pattern: /桌面|托盘|跨平台|desktop|electron|tray|cross-platform/i, emoji: "🖥️" },
  // 窗口与弹窗
  { pattern: /窗口|弹窗|对话框|浮层|全屏|window|modal|dialog|popup|resize/i, emoji: "🪟" },
  // 移动端
  { pattern: /移动|手机|响应式|mobile|ios|android|responsive/i, emoji: "📱" },
  // 终端与命令
  {
    pattern: /终端|命令行|控制台|命令|本地|terminal|shell|cli|console|command|local/i,
    emoji: "💻",
  },
  // 快捷键与输入
  {
    pattern: /快捷键|按键|热键|绑定|shortcut|keymap|hotkey|keyboard|bind|toggle|切换/i,
    emoji: "⌨️",
  },
  // 菜单
  { pattern: /菜单|右键|menu|context/i, emoji: "🍔" },
  // 面板与布局
  { pattern: /面板|侧边栏|停靠|多实例|panel|sidebar|dock|multi-instance/i, emoji: "🗂️" },
  // 监控与统计
  {
    pattern:
      /监控|统计|指标|状态|仪表盘|分析|可视化|monitor|metrics|telemetry|status|dashboard|analytics/i,
    emoji: "📊",
  },
  // 图表
  { pattern: /图表|曲线|走势|chart|graph/i, emoji: "📈" },
  // 通知
  { pattern: /通知|提醒|notification|toast|reminder/i, emoji: "🔔" },
  // 国际化
  { pattern: /国际化|翻译|语言|本地化|i18n|locale|translate|localization/i, emoji: "🌍" },
  // 版本与标签
  { pattern: /版本|标签|更新日志|version|semver|tag|changelog/i, emoji: "🏷️" },
  // 许可证与法律
  { pattern: /许可证|开源|法律|版权|license|copyright|legal/i, emoji: "⚖️" },
  // 邮件
  { pattern: /邮件|收件箱|email|inbox/i, emoji: "📧" },
  // 音频
  { pattern: /音频|声音|音量|音乐|audio|sound|music/i, emoji: "🔊" },
  // 视频与动画
  { pattern: /视频|录屏|媒体|动画|动效|video|media|stream|animation/i, emoji: "🎬" },
  // 图片与图标
  {
    pattern: /图片|图像|图标|头像|渲染|绘制|image|icon|svg|logo|avatar|render|paint/i,
    emoji: "🖼️",
  },
  // 截图
  { pattern: /截图|截屏|screenshot/i, emoji: "📸" },
  // 剪贴板
  { pattern: /剪贴板|复制|粘贴|拷贝|clipboard|copy|paste/i, emoji: "📋" },
  // 导入导出与传输
  { pattern: /导入|导出|上传|下载|传输|import|export|upload|download|transfer/i, emoji: "📥" },
  // 备份与恢复
  { pattern: /备份|恢复|还原|backup|restore/i, emoji: "💾" },
  // 定时与调度
  { pattern: /定时|调度|计划任务|倒计时|schedule|cron|timer|countdown/i, emoji: "⏰" },
  // 队列与任务
  { pattern: /队列|任务列表|待办|queue|todo/i, emoji: "🗃️" },
  // 删除与卸载
  { pattern: /删除|移除|卸载|废弃|remove|delete|uninstall|deprecate/i, emoji: "🗑️" },
  // 压缩与归档
  { pattern: /压缩|解压|归档|zip|tar|archive|compress/i, emoji: "🗜️" },
  // 编码与解析
  { pattern: /编码|解码|解析|序列化|encode|decode|parse|serialize|unicode/i, emoji: "🔣" },
  // 字符串与数字
  { pattern: /字符串|文本|字符|数字|计算|string|text|char|number|calc/i, emoji: "🔤" },
  // 鼠标与指针
  { pattern: /鼠标|指针|光标|拖拽|mouse|pointer|cursor|drag/i, emoji: "🖱️" },
  // 进程与工具
  { pattern: /进程|守护|任务管理器|process|daemon/i, emoji: "🛠️" },
  // 初始化与脚手架
  { pattern: /初始化|脚手架|模板|新建|init|scaffold|template/i, emoji: "🏗️" },
  // 滚动与分页
  { pattern: /滚动|分页|翻页|scroll|pagination/i, emoji: "📜" },
];

function pickEmojiForTitle(value: string): string {
  return (
    TITLE_EMOJI_BY_KEYWORD.find(({ pattern }) => pattern.test(value))?.emoji ?? DEFAULT_TITLE_EMOJI
  );
}

type TitleModelRegistry = {
  getApiKeyAndHeaders: (model: Model<Api>) => Promise<
    | {
        ok: true;
        apiKey?: string;
        headers?: ProviderHeaders;
        env?: Record<string, string>;
      }
    | { ok: false; error: string }
  >;
};

type CompleteTitle = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

function truncateTitle(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_SESSION_TITLE_LENGTH) return value;
  return `${chars.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join("")}…`;
}

function cleanTitle(value: string): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:session\s+title|title|会话标题|标题)\s*[:：-]\s*/i, "")
    .replace(/^[#>*_`'"“”‘’]+|[#>*_`'"“”‘’]+$/g, "")
    .replace(/[。.!?！？;；:：]+$/u, "")
    .trim();
  const leadingEmoji = /^(\p{Extended_Pictographic})/u.exec(cleaned)?.[1];
  // Keep at most the leading emoji; strip any emoji (and ZWJ sequences)
  // elsewhere so the final title always has exactly one emoji.
  const rest = cleaned
    .slice(leadingEmoji?.length ?? 0)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\u200D/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return leadingEmoji ? `${leadingEmoji} ${rest}`.trim() : rest;
}

function startsWithEmoji(value: string): boolean {
  return /^\p{Extended_Pictographic}/u.test(value);
}

function ensureLeadingEmoji(value: string): string {
  return startsWithEmoji(value) ? value : `${pickEmojiForTitle(value)} ${value}`;
}

export function sanitizeSessionTitle(value: string, fallback = DEFAULT_SESSION_TITLE): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => cleanTitle(line))
    .find(Boolean);
  return truncateTitle(ensureLeadingEmoji(firstLine || fallback));
}

export function createProvisionalSessionTitle(prompt: string): string {
  const firstSentence = prompt.split(/[\r\n。！？!?]/u).find((part) => part.trim());
  return sanitizeSessionTitle(firstSentence ?? prompt);
}

export function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      content?: unknown;
    };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) continue;
    return message.content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
        ),
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export async function generateRefinedSessionTitle(args: {
  model: Model<Api>;
  modelRegistry: TitleModelRegistry;
  userPrompt: string;
  assistantText: string;
  complete?: CompleteTitle;
}): Promise<string> {
  const auth = await args.modelRegistry.getApiKeyAndHeaders(args.model);
  if (!auth.ok) throw new Error(auth.error);

  const context: Context = {
    systemPrompt: [
      "Create a concise title for this coding-agent conversation.",
      "Use the same language as the user.",
      "Use at most 15 characters for CJK (at most 10 words for other languages).",
      "Begin with exactly one emoji that matches the topic, and use no other emoji.",
      "Do not use quotes, markdown, labels, or ending punctuation.",
      "Never include file paths, command lines, URLs, or code identifiers; write a human-readable topic title instead.",
      "Return only the title.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          `User request:\n${args.userPrompt}`,
          args.assistantText ? `Assistant response:\n${args.assistantText}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        timestamp: Date.now(),
      },
    ],
  };
  const response = await (args.complete ?? completeSimple)(args.model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: 96,
    reasoning: "minimal",
    timeoutMs: 120_000,
    maxRetries: 0,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Title generation ${response.stopReason}`);
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return sanitizeSessionTitle(text, createProvisionalSessionTitle(args.userPrompt));
}
