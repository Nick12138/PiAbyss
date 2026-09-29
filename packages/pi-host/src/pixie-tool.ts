/**
 * Pixie delegation & reporting tools.
 *
 * - `pixie_dispatch` — registered ONLY on the resident pixie session. The
 *   model fills in a target workspace cwd and a task prompt; the tool resolves
 *   the target session through the workspace graph factory (active →
 *   background → idle cache → new session) and injects the task prompt into
 *   it. Busy targets queue the prompt as a follow-up (delivered after the
 *   running turn settles — never interrupting the user's real-time turns).
 * - `pixie_report` — host-injected customTool on every workspace session
 *   (same mechanism as `piabyss_memo`). An activation extension keeps it
 *   dormant unless a live dispatch targets this session, so normal sessions
 *   never see it and workspace agents cannot call it without a delegation.
 *
 * Both tools talk to the runner's delegation registry, and reports are fed
 * back into the resident pixie session as user-turn messages.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { logger } from "./logger.js";
import { failDispatch, hasActiveDispatchFor, registerDispatch } from "./pixie-agent-runner.js";

export { failDispatch };

const PIXIE_DISPATCH_NAME = "pixie_dispatch";
const PIXIE_REPORT_NAME = "pixie_report";

const DispatchParams = Type.Object({
  cwd: Type.String({
    description: "目标工作区的绝对路径（用户提到哪个项目就填哪个项目的 cwd）。",
  }),
  task: Type.String({
    description:
      "委派提示词：包含任务目标、必要的上下文、完成后的回调要求（调用 pixie_report 报告「已完成 + 结果摘要」）。若任务源自某条备忘录，还应要求被委派 Agent 完成后用 piabyss_memo complete 回填。",
  }),
  newSession: Type.Optional(
    Type.Boolean({
      description: "true = 不复用目标工作区的既有会话，强制新开一个会话执行。默认 false。",
    }),
  ),
});

type DispatchParamsType = Static<typeof DispatchParams>;

/** Params accepted by the dispatch prompt injection. */
export type PixieDispatchRequest = {
  cwd: string;
  task: string;
  newSession?: boolean;
};

export type PixieDispatchResolution =
  | { ok: true; sessionId: string; sessionPath: string; queued: boolean }
  | { ok: false; error: string };

/**
 * Builds the pixie_dispatch tool. The `dispatch` callback is provided by the
 * controller that owns the workspace graph factory — the tool itself stays
 * transport-agnostic and testable.
 */
export function buildPixieDispatchTool(
  dispatch: (request: PixieDispatchRequest) => Promise<PixieDispatchResolution>,
): ToolDefinition {
  return defineTool({
    name: PIXIE_DISPATCH_NAME,
    label: "Pixie dispatch",
    description:
      "委派任务到某个工作区的正式会话执行（重活专用）。委派后立即返回受理结果；目标会话完成后会通过 pixie_report 回调，你收到回调后再向用户转述。",
    promptSnippet: "Delegate a task to a workspace session and wait for its callback",
    parameters: DispatchParams,
    async execute(_toolCallId, params: DispatchParamsType) {
      const request: PixieDispatchRequest = {
        cwd: params.cwd,
        task: params.task,
        ...(params.newSession !== undefined ? { newSession: params.newSession } : {}),
      };
      try {
        const resolution = await dispatch(request);
        if (!resolution.ok) {
          return {
            content: [{ type: "text" as const, text: `委派失败：${resolution.error}` }],
            details: undefined,
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `已派发到工作区会话（sessionId: ${resolution.sessionId}${resolution.queued ? "，该会话当前忙，任务已排队" : ""}）。等待其回调 pixie_report 后再向用户转述。`,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `委派失败：${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}

const ReportParams = Type.Object({
  result: Type.String({
    description:
      "结果摘要（Markdown）：已完成 + 关键结果与数据。控制在 500 字以内，不要粘贴全文——全文留在本会话里，用户可随时打开查看。",
  }),
  success: Type.Optional(
    Type.Boolean({ description: "任务是否成功完成。默认 true；失败或部分完成时设为 false。" }),
  ),
});

type ReportParamsType = Static<typeof ReportParams>;

/**
 * Builds the pixie_report tool for a workspace session. `sessionInfo` is
 * captured lazily (tool executes inside the target session's turn).
 */
export function buildPixieReportTool(options: {
  agentDir: string;
  getSessionId: () => string | null;
  report: (args: { dispatchId: string; summary: string; success: boolean }) => Promise<
    | {
        ok: true;
      }
    | { ok: false; error: string }
  >;
  findDispatch: (sessionId: string) => { id: string } | undefined;
}): ToolDefinition {
  return defineTool({
    name: PIXIE_REPORT_NAME,
    label: "Pixie report",
    description:
      "向「小精灵」回调委派任务的结果（仅在被委派的任务会话中使用）。完成任务后调用：报告已完成状态与结果摘要，小精灵会把结果转述给用户。",
    promptSnippet: "Report a delegated task's result back to the pixie helper",
    parameters: ReportParams,
    async execute(_toolCallId, params: ReportParamsType) {
      const sessionId = options.getSessionId();
      const dispatch = sessionId ? options.findDispatch(sessionId) : undefined;
      if (!dispatch) {
        return {
          content: [{ type: "text" as const, text: "Error: 当前会话没有进行中的小精灵委派。" }],
          details: undefined,
          isError: true,
        };
      }
      const summary = params.result.trim();
      if (!summary) {
        return {
          content: [{ type: "text" as const, text: "Error: result 摘要不能为空。" }],
          details: undefined,
          isError: true,
        };
      }
      const success = params.success ?? true;
      const out = await options.report({
        dispatchId: dispatch.id,
        summary,
        success,
      });
      if (!out.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${out.error}` }],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "已回调小精灵。用户会在小精灵对话里看到你的结果转述；本会话可以继续接受新任务。",
          },
        ],
        details: undefined,
      };
    },
  });
}

/**
 * Activation extension for the report tool on workspace sessions (mirrors the
 * memo tool's activation): the tool is registered on every session but kept
 * OUT of the active set unless a live dispatch targets this session.
 */
export function createPixieReportActivationExtension(): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", () => {
      let active: string[];
      try {
        active = pi.getActiveTools();
      } catch {
        return;
      }
      const hasReport = active.includes(PIXIE_REPORT_NAME);
      // Activation state is re-evaluated each turn: when a live dispatch
      // targets this session the report tool joins the active set; otherwise
      // it is pruned so normal workspace turns never see it.
      if (pixieReportWanted && !hasReport) {
        pi.setActiveTools([...active, PIXIE_REPORT_NAME]);
      } else if (!pixieReportWanted && hasReport) {
        pi.setActiveTools(active.filter((name) => name !== PIXIE_REPORT_NAME));
      }
    });
  };
}

/**
 * Turn-level switch the host flips while any dispatch is live: the activation
 * extension evaluates it at each turn start. The registry check inside the
 * tool still guards against sessions without a matching dispatch.
 */
let pixieReportWanted = false;

function setPixieReportActive(active: boolean): void {
  pixieReportWanted = active;
}

/** Convenience wrapper the lifecycle code calls when a delegated prompt is
 *  injected: registers the dispatch and flips the report tool on. */
export function armPixieDispatch(input: {
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  task: string;
}): string {
  const record = registerDispatch(input);
  setPixieReportActive(true);
  logger.info("pixie dispatch armed", { dispatchId: record.id, sessionId: input.sessionId });
  return record.id;
}
