/**
 * PiAbyss 内置备忘录工具 —— 注册 `piabyss_memo` 工具。
 *
 * 「用 Agent 处理」一条备忘录时，桌面端把记录内容以引用块注入会话；
 * agent 处理完后通过本工具把该记录标记为已完成（或重新打开 / 更新正文）。
 * 与 `ask_user_question` 一样是 Host 内置 customTool：磁盘包同名工具无法
 * 遮蔽它。工具直接读写 MemoStore（磁盘权威，无缓存），与协议 handler、
 * 未来的云同步引擎共享同一份数据。
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { MemoNote } from "@piabyss/protocol";
import { getMemoStore } from "./memo-store.js";

const MEMO_TOOL_NAME = "piabyss_memo";

const ParamsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("complete"),
      Type.Literal("reopen"),
      Type.Literal("update"),
    ],
    {
      description:
        "list = show all memo notes with ids and statuses; complete = mark a note as done after finishing the work it asked for; reopen = mark a done note as open again; update = change a note's title/content/tags.",
    },
  ),
  id: Type.Optional(
    Type.String({ description: "The memo note id. Required for complete/reopen/update." }),
  ),
  title: Type.Optional(Type.String({ description: "New title (update action only)." })),
  contentMd: Type.Optional(Type.String({ description: "New markdown body (update action only)." })),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "New tag list replacing the old one (update action only).",
    }),
  ),
});

type MemoParams = Static<typeof ParamsSchema>;

const TOOL_DESCRIPTION = [
  "Access the user's PiAbyss memo board (备忘录).",
  "Use it to list pending notes, and to mark a note as complete (complete) once the task described in it has been handled, or to reopen/update notes.",
  "A note id is required for complete/reopen/update; call list first if you don't have one.",
].join(" ");

/** 面向模型的单条记录摘要行。 */
function formatNote(note: MemoNote): string {
  const parts = [
    `id: ${note.id}`,
    `type: ${note.type}`,
    `status: ${note.status}`,
    `title: ${note.title}`,
  ];
  if (note.tags.length) parts.push(`tags: ${note.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (note.workspaceHint) parts.push(`workspace: ${note.workspaceHint}`);
  const updated = new Date(note.updatedAt).toISOString();
  parts.push(`updated: ${updated}`);
  return `- ${parts.join(" | ")}`;
}

export function buildMemoTool(agentDir: string): ToolDefinition {
  const store = getMemoStore(agentDir);
  return defineTool({
    name: MEMO_TOOL_NAME,
    label: "PiAbyss memo",
    description: TOOL_DESCRIPTION,
    promptSnippet: "List and update the user's memo notes (mark done after handling)",
    parameters: ParamsSchema,
    async execute(_toolCallId, params: MemoParams) {
      try {
        if (params.action === "list") {
          const notes = store.list();
          if (notes.length === 0) {
            return {
              content: [{ type: "text" as const, text: "The memo board is empty." }],
              details: undefined,
            };
          }
          const body = notes.map(formatNote).join("\n");
          return {
            content: [{ type: "text" as const, text: `Memo notes (${notes.length}):\n${body}` }],
            details: undefined,
          };
        }

        const id = params.id?.trim();
        if (!id) {
          return {
            content: [
              { type: "text" as const, text: "Error: a note id is required for this action." },
            ],
            details: undefined,
            isError: true,
          };
        }

        if (params.action === "complete" || params.action === "reopen") {
          const note = store.update(id, { status: params.action === "complete" ? "done" : "open" });
          return {
            content: [
              {
                type: "text" as const,
                text: `Memo note ${note.title} is now ${note.status}.`,
              },
            ],
            details: undefined,
          };
        }

        // update
        const patch: Parameters<typeof store.update>[1] = {};
        if (params.title !== undefined) patch.title = params.title;
        if (params.contentMd !== undefined) patch.contentMd = params.contentMd;
        if (params.tags !== undefined) patch.tags = params.tags;
        if (Object.keys(patch).length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: nothing to update." }],
            details: undefined,
            isError: true,
          };
        }
        const note = store.update(id, patch);
        return {
          content: [{ type: "text" as const, text: `Memo note updated:\n${formatNote(note)}` }],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}

/**
 * 激活钩子：settings.json 的 `defaultTools` 通常不含本工具，注册后默认处于
 * 未激活状态。这个内联扩展在每轮开始前把它加回激活集合（v1 恒开，无开关）。
 */
export function createMemoActivationExtension(): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", () => {
      const active = pi.getActiveTools();
      if (!active.includes(MEMO_TOOL_NAME)) {
        pi.setActiveTools([...active, MEMO_TOOL_NAME]);
      }
    });
  };
}
