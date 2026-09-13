/**
 * PiAbyss 内置提问插件 —— 注册 `ask_user_question` 工具。
 *
 * 这是一个 Host 内置扩展（inline ExtensionFactory），不是功能扩展：它由
 * `createAgentSession` 的 `customTools` 选项注入。SDK 的工具注册表把 `customTools`
 * 排在扩展工具之后覆盖写入，因此与磁盘包同名时本实现确定性胜出。
 *
 * 设计取舍：问卷不走 `ctx.ui.custom()`（那会把卡片送进右侧 dock 的虚拟终端），
 * 而是走原生 dialog 原语。每道题压成一次 `ui.select`，选项的 `description` /
 * `preview` 经 `piabyss.optionDetails` 元数据一并送出，桌面端复用已有的内联/
 * 弹窗卡片渲染等宽预览面板。
 *
 * 返回信封保持 `{ answers, cancelled }` 形状，与既有路径一致，桌面端的 group
 * 串联、队列整合与过期处理都不需要改动。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

/** 与 rpiv 一致的边界，避免模型越界后被拒绝却无从下手。 */
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;
/** 单个 preview 的字符上限（Host 侧独立于协议上限，留出信封余量）。 */
export const MAX_PREVIEW_LENGTH = 6_000;

/** 追加到每道题的哨兵行标签，语义等价于 rpiv 的 “Type something.”。 */
export const CUSTOM_ROW_LABEL = "Type something.";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS. Concise (1-5 words) display text for this choice.`,
  }),
  description: Type.String({
    description:
      "One-line explanation of what this option means or its trade-offs. Shown under the label.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional markdown preview for this option: mockups, ASCII layouts, code snippets, diagrams. Rendered in a monospace panel beside the options. Prefer fenced code blocks for ASCII art so alignment is preserved.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      "The complete question to ask. Clear, specific, ending with a question mark. If multiSelect is true, phrase it accordingly.",
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS. Very short chip shown next to the question, e.g. "Auth method", "Layout".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `The available choices (${MIN_OPTIONS}-${MAX_OPTIONS}). Mutually exclusive unless multiSelect is set. A "${CUSTOM_ROW_LABEL}" row is appended automatically — do NOT author it.`,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Allow selecting several options instead of one.",
    }),
  ),
});

const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: `Questions to ask the user (1-${MAX_QUESTIONS}).`,
  }),
});

export type AskUserQuestion = Static<typeof QuestionSchema>;
export type AskUserParams = Static<typeof QuestionParamsSchema>;

/** 模型可见的工具说明：保留 rpiv 的关键引导，但更短。 */
const TOOL_DESCRIPTION = [
  "Ask the user a structured question when you would otherwise have to guess.",
  "",
  `- Provide 1-${MAX_QUESTIONS} questions, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options.`,
  "- Each option needs a concise label (1-5 words) and a one-line description.",
  "- Use multiSelect: true when several answers may apply.",
  "- Use options[].preview for mockups, ASCII layouts, code snippets or diagrams that help compare choices. Prefer fenced code blocks for ASCII art.",
  `- A "${CUSTOM_ROW_LABEL}" row is appended to every question automatically; do NOT author "Other" or "${CUSTOM_ROW_LABEL}" yourself.`,
  "- Do not use this tool to ask for confirmation of an action you are about to take; just take it.",
].join("\n");

type QuestionAnswer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
};

type QuestionnaireResult = {
  answers: QuestionAnswer[];
  cancelled: boolean;
};

type PiAbyssOptionDetail = {
  id: string;
  description?: string;
  preview?: string;
};

/**
 * 每道题渲染成一次 `ui.select` 所需的载荷。
 *
 * `values` 是人可读的选项串（`ui.select` 只接受 string[] 且以选中串返回），
 * `byValue` 把该串映射回选项下标；`customValue` 是追加的哨兵行。三者必须由
 * 同一函数一次构造，避免标签去重后下标错位。
 */
type SelectPlan = {
  values: string[];
  byValue: Map<string, number>;
  customValue: string;
  optionDetails: PiAbyssOptionDetail[];
};

/**
 * 重复标签会破坏「串 → 下标」的一一映射，追加序号消歧。
 *
 * `ui.select` 只回传被选中的字符串，所以两个同名选项无法区分；这里让展示串
 * 唯一。用户看到的标签保持原样（第一个不变），只有重复项带上 "(2)"。
 */
function disambiguate(label: string, used: Set<string>): string {
  if (!used.has(label)) {
    used.add(label);
    return label;
  }
  let attempt = 2;
  let candidate = `${label} (${attempt})`;
  while (used.has(candidate)) {
    attempt += 1;
    candidate = `${label} (${attempt})`;
  }
  used.add(candidate);
  return candidate;
}

export function buildSelectPlan(question: AskUserQuestion): SelectPlan {
  const used = new Set<string>();
  const byValue = new Map<string, number>();
  const optionDetails: PiAbyssOptionDetail[] = [];
  const values = question.options.map((option, index) => {
    const value = disambiguate(option.label, used);
    byValue.set(value, index);
    optionDetails.push({
      id: value,
      description: option.description,
      ...(option.preview ? { preview: option.preview.slice(0, MAX_PREVIEW_LENGTH) } : {}),
    });
    return value;
  });
  const customValue = disambiguate(CUSTOM_ROW_LABEL, used);
  values.push(customValue);
  return { values, byValue, customValue, optionDetails };
}

/**
 * 把 `ui.select` 的返回值翻译成一条答案。
 *
 * 三种来源必须区分：命中选项映射 → 选项答案；等于哨兵串 → 由调用方追问自由
 * 文本；其余任何串 → 桌面卡片自由输入框直接提交的文本（`allowFreeform`）。
 */
export function resolveSelection(
  plan: SelectPlan,
  question: AskUserQuestion,
  questionIndex: number,
  selected: string,
): { answer: QuestionAnswer } | { freeform: true } {
  const index = plan.byValue.get(selected);
  if (index !== undefined) {
    return {
      answer: {
        questionIndex,
        question: question.question,
        kind: "option",
        answer: question.options[index]!.label,
      },
    };
  }
  if (selected === plan.customValue) return { freeform: true };
  return {
    answer: { questionIndex, question: question.question, kind: "custom", answer: selected },
  };
}

/** 多选：原生 select 无多选能力，用数字输入承载，语义与 rpiv 一致。 */
async function askMultiSelect(
  ctx: ExtensionContext,
  question: AskUserQuestion,
  questionIndex: number,
  header: string,
): Promise<QuestionAnswer | undefined> {
  const list = question.options
    .map((option, index) => `${index + 1}. ${option.label} — ${option.description}`)
    .join("\n");
  const value = await ctx.ui.input(
    `${header}${question.question}\n\n${list}\n\nEnter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer.`,
    "1,3",
  );
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      questionIndex,
      question: question.question,
      kind: "multi",
      answer: null,
      selected: [],
    };
  }
  const tokens = trimmed.split(/[,\s]+/).filter((token) => token.length > 0);
  const indices = tokens.map((token) => {
    if (!/^\d+\.?$/.test(token)) return null;
    const index = Number.parseInt(token, 10) - 1;
    return index >= 0 && index < question.options.length ? index : null;
  });
  if (indices.every((index): index is number => index !== null)) {
    const selected: string[] = [];
    for (const index of indices) {
      const label = question.options[index]!.label;
      if (!selected.includes(label)) selected.push(label);
    }
    return { questionIndex, question: question.question, kind: "multi", answer: null, selected };
  }
  // 任何非下标 token 都视为用户直接输入的自定义答案，而不是静默丢弃。
  return { questionIndex, question: question.question, kind: "custom", answer: trimmed };
}

/**
 * 依次询问每道题。任何一次取消都会终止整份问卷（与 rpiv 的 Esc 语义一致），
 * 已作答的部分保留在结果里。
 */
async function runQuestionnaire(
  ctx: ExtensionContext,
  params: AskUserParams,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex += 1) {
    const question = params.questions[questionIndex]!;
    const header = question.header ? `[${question.header}] ` : "";

    if (question.multiSelect) {
      const answer = await askMultiSelect(ctx, question, questionIndex, header);
      if (!answer) return { answers, cancelled: true };
      answers.push(answer);
      continue;
    }

    const plan = buildSelectPlan(question);
    const selected = await ctx.ui.select(`${header}${question.question}`, plan.values, {
      piabyss: {
        optionDetails: plan.optionDetails,
        allowFreeform: true,
      },
    });
    if (selected === undefined) return { answers, cancelled: true };

    const resolved = resolveSelection(plan, question, questionIndex, selected);
    if ("answer" in resolved) {
      answers.push(resolved.answer);
      continue;
    }
    const typed = await ctx.ui.input(`${header}${question.question}`, "");
    if (typed === undefined) return { answers, cancelled: true };
    answers.push({
      questionIndex,
      question: question.question,
      kind: "custom",
      answer: typed,
    });
  }
  return { answers, cancelled: false };
}

/** 面向模型的结果文本：逐题回显问题与答案。 */
function formatAnswers(result: QuestionnaireResult): string {
  if (result.cancelled) {
    return result.answers.length === 0
      ? "The user cancelled the questionnaire without answering."
      : `The user cancelled the questionnaire after answering ${result.answers.length} of the questions.`;
  }
  return result.answers
    .map((answer) => {
      const value =
        answer.kind === "multi" ? (answer.selected ?? []).join(", ") : (answer.answer ?? "");
      return `${answer.question} -> ${value}`;
    })
    .join("\n");
}

/**
 * 工具定义本身。
 *
 * 通过 `customTools` 选项注入，而不是 `pi.registerTool()`：
 * SDK 的工具注册表先写磁盘包的工具、再写 `customTools`，因此同名时 Host 内置
 * 实现确定性胜出，任何第三方同名插件都无法遮蔽它。
 */
export function buildAskUserQuestionTool(): ToolDefinition {
  return defineTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask user question",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Ask the user a structured question with typed options",
    parameters: QuestionParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runQuestionnaire(ctx, params);
      return {
        content: [{ type: "text" as const, text: formatAnswers(result) }],
        details: result,
      };
    },
  });
}

/**
 * `settings.json` 里的开关。缺省为开；只有显式 `false` 才关闭。
 *
 * 直接读文件而不是走 SettingsManager：开关变化后不需要重建会话，下一次
 * `before_agent_start` 读到的就是新值。
 */
export function isAskUserQuestionEnabled(agentDir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    return (raw as Record<string, unknown>).askUserQuestionEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * 激活/停用钩子。
 *
 * 工具的注册与它的激活是两件事：用户 `settings.json` 通常显式列出
 * `defaultTools` 且不含本工具，所以注册之后它仍处于未激活状态。这个内联扩展
 * 在每轮开始前按开关把它加回或移除，模型因此既看不到被关掉的工具，也不会因为
 * 显式 `defaultTools` 而丢失它。
 */
export function createAskUserQuestionActivationExtension(
  isEnabled: () => boolean,
): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", () => {
      const active = pi.getActiveTools();
      const hasTool = active.includes(ASK_USER_QUESTION_TOOL_NAME);
      if (!isEnabled()) {
        if (hasTool)
          pi.setActiveTools(active.filter((name) => name !== ASK_USER_QUESTION_TOOL_NAME));
        return;
      }
      if (!hasTool) pi.setActiveTools([...active, ASK_USER_QUESTION_TOOL_NAME]);
    });
  };
}
