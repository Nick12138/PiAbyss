import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Loader2,
  Pencil,
  Sparkles,
} from "lucide-react";
import type {
  ScheduleJobInput,
  SerializableAgentContent,
  SerializableAgentMessage,
} from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { markAgentSessionHandled, useScheduleAgentStore } from "./schedule-agent-store";
import { leaveScheduleAgent } from "./schedule-agent-flow";
import {
  schedulePlanMissingFields,
  schedulePlanPreviewRows,
  type SchedulePlanDraft,
} from "./schedule-model";
import { ModelControls } from "../chat/ModelControls";
import { TranscriptRowView } from "../chat/Transcript";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import { ScheduleJobDialog } from "./ScheduleJobDialog";
import { formToPlan, planToForm } from "./schedule-model";

const AGENT_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 15_000;
const POLL_IDLE_MS = 2_500;
const POLL_ACTIVE_MS = 1_200;

/** One message of the `schedule.agentState` transcript. */
export type ScheduleAgentTranscriptMessage = {
  role: string;
  text: string;
  reasoning?: string;
  content?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

/**
 * Project one schedule message into the conversation area's wire shape.
 *
 * The plan block is stripped from answer text (it feeds the preview panel) and
 * only that: tool calls, reasoning, results and the `toolResult` linkage all
 * pass through untouched, so `buildTranscriptRows` can fold them with the same
 * disclosures as a normal workspace session.
 */
function toSerializableMessage(
  message: ScheduleAgentTranscriptMessage,
  planStub: string,
): SerializableAgentMessage | null {
  if (message.role === "toolResult") {
    // Keep the result linkage: `buildTranscriptRows` settles the matching
    // tool call from this message, exactly like the workspace transcript.
    return {
      role: "toolResult",
      content: Array.isArray(message.content)
        ? (message.content as SerializableAgentContent[])
        : "",
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.isError ? { isError: true } : {}),
    };
  }
  const blocks: SerializableAgentContent[] = [];
  const raw = Array.isArray(message.content) ? message.content : [];
  for (const part of raw) {
    if (!part || typeof part !== "object") continue;
    const block = part as SerializableAgentContent;
    if (block.type === "text") {
      const text = stripPlanBlocks(typeof block.text === "string" ? block.text : "");
      if (text) blocks.push({ ...block, text });
      continue;
    }
    blocks.push(block);
  }
  if (blocks.length === 0) {
    // Older hosts (or persisted sessions) only carry the flattened fields.
    const reasoning = message.reasoning?.trim();
    if (reasoning) blocks.push({ type: "thinking", thinking: reasoning });
    const text = stripPlanBlocks(message.text);
    if (text) blocks.push({ type: "text", text });
    // The message carried nothing but its plan block: the preview panel updated
    // silently, so leave an inline marker instead of dropping the turn.
    else if (message.text.trim()) blocks.push({ type: "text", text: planStub });
  }
  return blocks.length > 0 ? { role: message.role, content: blocks } : null;
}

/**
 * Project the conversation into workspace-transcript rows.
 *
 * Consecutive assistant messages merge into a single turn row by
 * `buildTranscriptRows`, so a settled turn folds into the same
 * "N tool calls · M messages" summary row the conversation area shows, while a
 * running turn streams its interleaved thinking / text / tool cards live. That
 * shared projection is the whole point: the schedule page owns only the wire
 * shape, never its own fold logic.
 */
export function buildScheduleRows(
  messages: readonly ScheduleAgentTranscriptMessage[],
  planStub: string,
  turnActive: boolean,
): TranscriptRow[] {
  const projected: SerializableAgentMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user" && index === 0) {
      // The first user message bundles the injected preamble with the
      // requirement; only the requirement belongs in the bubble.
      const { requirement } = splitUserMessage(message.text);
      projected.push({ role: "user", content: [{ type: "text", text: requirement }] });
      return;
    }
    const next = toSerializableMessage(message, planStub);
    if (next) projected.push(next);
  });
  // turnActive mirrors the workspace session: while the agent runs, tool calls
  // still awaiting their result stay open instead of being settled as aborted.
  return buildTranscriptRows(projected, { turnActive });
}

/** Latest ```schedule-plan JSON from the assistant messages. */
function extractPlanDraft(
  messages: readonly ScheduleAgentTranscriptMessage[],
): SchedulePlanDraft | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const match = message.text.match(/```schedule-plan\s*\n([\s\S]*?)```/);
    if (!match) continue;
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as SchedulePlanDraft;
      }
    } catch {
      /* keep scanning older messages */
    }
  }
  return null;
}

/** Remove ```schedule-plan fences from assistant text. The plan JSON feeds
 *  the preview panel (extractPlanDraft); the transcript itself should stay
 *  clean, so the block is stripped at render time — including the still-
 *  streaming tail of an unclosed fence. */
export function stripPlanBlocks(text: string): string {
  let out = text.replace(/```schedule-plan[^\n]*\n[\s\S]*?```/g, "");
  const open = out.indexOf("```schedule-plan");
  if (open >= 0) out = out.slice(0, open);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export type SplitUserMessage = {
  /** Injected system preamble（提示词注入段），rendered collapsed by default. */
  preamble: string | null;
  /** What the user actually typed. */
  requirement: string;
  /** AI 优化会话的目标计划上下文；普通智能创建为 null。 */
  editingJob: { id: string; enabled: boolean; loadExtensions: boolean } | null;
};

/** The first user message of a smart-creation session bundles the injected
 *  preamble and the user's requirement into one string. Split them for
 *  separate rendering. New sessions wrap the preamble in
 *  <schedule-preamble>...</schedule-preamble> sentinels; older persisted
 *  transcripts fall back to the "用户需求：" separator. */
export function splitUserMessage(text: string): SplitUserMessage {
  const split: SplitUserMessage = { preamble: null, requirement: text, editingJob: null };
  const open = text.indexOf("<schedule-preamble>");
  if (open >= 0) {
    const close = text.indexOf("</schedule-preamble>", open);
    if (close >= 0) {
      const before = text.slice(0, open).trim();
      const preamble = text.slice(open + "<schedule-preamble>".length, close).trim();
      let after = text
        .slice(close + "</schedule-preamble>".length)
        .replace(/^\s*用户需求[:：]\s*\n?/, "")
        .trim();
      // AI 优化会话：首条消息携带 <schedule-job id="...">JSON</schedule-job>
      // 原计划上下文；展示时剥去，但解析出 id / enabled / loadExtensions 供
      // 确认更新时恢复原计划的不可编辑字段。
      const jobMatch = after.match(/<schedule-job id="([^"]*)">([\s\S]*?)<\/schedule-job>/);
      if (jobMatch) {
        let enabled = true;
        let loadExtensions = false;
        try {
          const parsed = JSON.parse(jobMatch[2]) as {
            enabled?: unknown;
            loadExtensions?: unknown;
          };
          if (typeof parsed.enabled === "boolean") enabled = parsed.enabled;
          if (typeof parsed.loadExtensions === "boolean") loadExtensions = parsed.loadExtensions;
        } catch {
          /* malformed context: fall back to the safe defaults */
        }
        split.editingJob = { id: jobMatch[1], enabled, loadExtensions };
        after = after.replace(/<schedule-job[\s\S]*?<\/schedule-job>/, "").trim();
      }
      const requirement = [before, after].filter(Boolean).join("\n").trim();
      split.preamble = preamble || null;
      split.requirement = requirement || text.trim();
      return split;
    }
  }
  const marker = "用户需求：";
  const at = text.indexOf(marker);
  if (at >= 0) {
    const preamble = text.slice(0, at).trim();
    const requirement = text.slice(at + marker.length).trim();
    if (preamble && requirement) {
      split.preamble = preamble;
      split.requirement = requirement;
    }
  }
  return split;
}

/** 二级智能创建页：左侧为周期计划自有的对话区（独立会话，不进工作区会话
 *  列表），右侧为配置实时预览。 */
export function ScheduleAgentPage() {
  const t = useT();
  const setPage = useAppStore((s) => s.setPage);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const workspace = useAppStore((s) => s.workspace);
  const sessionId = useScheduleAgentStore((s) => s.sessionId);
  const sessionPath = useScheduleAgentStore((s) => s.sessionPath);
  const [messages, setMessages] = useState<ScheduleAgentTranscriptMessage[]>([]);
  const [resident, setResident] = useState(true);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 手动编辑弹窗：把当前预览草稿预填进创建/编辑弹窗。 */
  const [editOpen, setEditOpen] = useState(false);
  /** 手动编辑保存的草稿覆盖：只在 AI 未再更新计划（baseAiPlan 未变）时生效，
   *  AI 继续对话给出新计划后自动失效。保存不创建，创建仍由确认创建负责。 */
  const [draftOverride, setDraftOverride] = useState<{
    baseAiPlan: string;
    plan: SchedulePlanDraft;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const lastMessageCountRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [preambleOpen, setPreambleOpen] = useState(false);
  // 窄屏（<@3xl）下预览面板折叠；宽屏右侧常驻，此状态不生效。
  const [previewOpen, setPreviewOpen] = useState(false);
  /**
   * Resolved host default model, for the preview's `model` row. Read from
   * `piSettings.get` — the same host-scoped snapshot the create dialog and the
   * settings page use — so a plan without an explicit model shows the model it
   * will really run with instead of an "undetermined" placeholder.
   */
  const [hostDefaultModelLabel, setHostDefaultModelLabel] = useState(() =>
    t("scheduleModelDefaultPlain"),
  );

  useEffect(() => {
    const host = useAppStore.getState().host;
    if (!host) return;
    let cancelled = false;
    void hostClient
      .request("piSettings.get", hostContext(host), null, AGENT_TIMEOUT_MS)
      .then((response) => {
        if (cancelled || !response.ok) return;
        const { defaultProvider, defaultModel } = response.result;
        if (!defaultProvider || !defaultModel) return;
        const name = response.result.models.find(
          (model) => model.provider === defaultProvider && model.modelId === defaultModel,
        )?.name;
        setHostDefaultModelLabel(
          t("scheduleModelDefault", { name: name ?? `${defaultProvider}/${defaultModel}` }),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [t]);

  const refresh = useCallback(async () => {
    if (!sessionId || !sessionPath) return;
    const host = useAppStore.getState().host;
    if (!host) return;
    try {
      const state = await hostClient.request(
        "schedule.agentState",
        hostContext(host),
        { sessionId },
        AGENT_TIMEOUT_MS,
      );
      if (state.ok && state.result.found) {
        setResident(true);
        setRunning(state.result.running);
        setLoadError(null);
        setMessages(state.result.messages);
        return;
      }
      // Non-resident (host restarted, found: false) or state request failed:
      // fall back to the persisted transcript.
      const transcript = await hostClient.request(
        "schedule.agentTranscript",
        hostContext(host),
        { sessionPath },
        AGENT_TIMEOUT_MS,
      );
      if (transcript.ok && transcript.result.found) {
        setResident(false);
        setRunning(false);
        setLoadError(null);
        setMessages(transcript.result.messages);
      } else if (transcript.ok && !transcript.result.found) {
        setLoadError(t("scheduleAgentTranscriptMissing"));
      } else if (!transcript.ok) {
        setLoadError(
          state.ok
            ? (transcript.error?.message ?? t("scheduleLoadFailed"))
            : (state.error?.message ?? t("scheduleLoadFailed")),
        );
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("scheduleLoadFailed"));
    }
  }, [sessionId, sessionPath, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), running ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, running]);

  // Auto-scroll to bottom only when: 1) new messages arrive from assistant, 2) user sends a message, or 3) user hasn't manually scrolled
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;

    // Check if user has scrolled away from bottom
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;

    // Only auto-scroll if:
    // 1. User hasn't manually scrolled away (userScrolledRef is false)
    // 2. OR user is already near the bottom
    // 3. OR this is a new message (not just a status update)
    const messageCountIncreased = messages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;

    if (!userScrolledRef.current || isNearBottom || messageCountIncreased) {
      el.scrollTop = el.scrollHeight;
      userScrolledRef.current = false;
    }
  }, [messages]);

  // Track user's manual scroll
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;

    const handleScroll = () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      // If user scrolls away from bottom, mark as manually scrolled
      if (!isNearBottom) {
        userScrolledRef.current = true;
        setShowScrollToBottom(true);
      } else {
        setShowScrollToBottom(false);
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const aiPlan = useMemo(() => extractPlanDraft(messages), [messages]);
  const aiPlanKey = useMemo(() => (aiPlan ? JSON.stringify(aiPlan) : ""), [aiPlan]);
  /** AI 优化会话的目标计划：从首条用户消息的 <schedule-job> 块解析。 */
  const editingJob = useMemo(() => {
    const first = messages[0];
    return first?.role === "user" ? splitUserMessage(first.text).editingJob : null;
  }, [messages]);
  const rawPlan =
    draftOverride && draftOverride.baseAiPlan === aiPlanKey ? draftOverride.plan : aiPlan;
  // 优化会话：不可编辑字段（loadExtensions 等）以原计划为准，AI 草稿不覆盖。
  const plan = useMemo(
    () =>
      editingJob && rawPlan ? { ...rawPlan, loadExtensions: editingJob.loadExtensions } : rawPlan,
    [editingJob, rawPlan],
  );
  /** Injected preamble of the first user turn (null when the session has none). */
  const preamble = useMemo(() => {
    const first = messages[0];
    return first?.role === "user" ? splitUserMessage(first.text).preamble : null;
  }, [messages]);
  /** Transcript rows, projected exactly like a workspace session's. */
  const rows = useMemo(
    () => buildScheduleRows(messages, t("scheduleAgentPlanUpdated"), running),
    [messages, running, t],
  );
  // While the agent streams, the trailing assistant turn renders with the
  // conversation area's live caret + working header.
  const workingRowKey = useMemo(() => {
    if (!running) return undefined;
    const tail = rows[rows.length - 1];
    return tail?.role === "assistant" ? tail.key : undefined;
  }, [rows, running]);
  async function send() {
    const text = draft.trim();
    if (!text || sending || !sessionId || !sessionPath) return;
    const host = useAppStore.getState().host;
    if (!host) return;
    setSending(true);
    setLoadError(null);
    setMessages((current) => [...current, { role: "user", text }]);
    setDraft("");
    // Reset user scroll flag when user sends a message - we want to auto-scroll to the new message
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
    try {
      const response = resident
        ? await hostClient.request(
            "schedule.agentSend",
            hostContext(host),
            { sessionId, text },
            SEND_TIMEOUT_MS,
          )
        : await hostClient.request(
            "schedule.agentContinue",
            hostContext(host),
            { sessionPath, cwd: workspace?.cwd ?? "", text },
            SEND_TIMEOUT_MS,
          );
      if (!response.ok) {
        setLoadError(response.error?.message ?? t("scheduleLoadFailed"));
        setMessages((current) => [...current, { role: "user", text }]);
      } else if (!resident && "sessionPath" in response.result) {
        // Continued via a fork: the turns now live in a NEW session file.
        // Track it and retire the forked-from path so the backlog shows one
        // entry and later replies keep the new history.
        markAgentSessionHandled(sessionPath);
        useScheduleAgentStore.getState().setSession({
          sessionId: response.result.sessionId,
          sessionPath: response.result.sessionPath,
        });
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("scheduleLoadFailed"));
    } finally {
      setSending(false);
      void refresh();
    }
  }

  async function handleBack() {
    leaveScheduleAgent();
    setPage("schedule");
  }

  function scrollToBottom() {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      userScrolledRef.current = false;
      setShowScrollToBottom(false);
    }
  }

  /** 会话已结束（计划已创建）：删除智能创建会话（常驻状态 + 会话文件），
   *  返回周期计划页。确认创建和手动编辑保存共用。 */
  async function finishCreated() {
    useScheduleAgentStore.getState().markCreated();
    const host = useAppStore.getState().host;
    const path = useScheduleAgentStore.getState().sessionPath;
    if (host && path) {
      try {
        await hostClient.request(
          "schedule.agentDelete",
          hostContext(host),
          { sessionPath: path },
          CREATE_TIMEOUT_MS,
        );
      } catch {
        /* handled mark below still hides it */
      }
    }
    leaveScheduleAgent();
    setPage("schedule");
  }

  async function handleConfirm() {
    if (!plan || !planReady || creating) return;
    setCreating(true);
    try {
      const host = useAppStore.getState().host;
      if (!host) return;
      const input: ScheduleJobInput = {
        name: String(plan.name),
        prompt: plan.kind === "command" ? "" : String(plan.prompt ?? ""),
        command: plan.kind === "command" ? String(plan.command ?? "") : null,
        cwd: String(plan.cwd),
        // The AI emits the plugin's trigger shape verbatim.
        trigger: plan.trigger as ScheduleJobInput["trigger"],
        permission: (plan.permission ?? undefined) as ScheduleJobInput["permission"],
        model: (plan.model ?? null) as ScheduleJobInput["model"],
        missedWindow: (plan.missedWindow ?? undefined) as ScheduleJobInput["missedWindow"],
        timeoutMs: (plan.timeoutMs ?? undefined) as ScheduleJobInput["timeoutMs"],
        maxRuns: (plan.maxRuns ?? null) as ScheduleJobInput["maxRuns"],
        loadExtensions: editingJob ? editingJob.loadExtensions : false,
        tags: Array.isArray(plan.tags) ? plan.tags.map(String) : [],
        enabled: editingJob ? editingJob.enabled : true,
        notify: (plan.notify ?? undefined) as ScheduleJobInput["notify"],
      };
      // 优化会话：按 id 覆盖原计划（插件 PATCH 只改提交的字段，执行历史、
      // 运行计数等都保留），普通智能创建则新建计划。
      const response = editingJob
        ? await hostClient.request(
            "schedule.updateJob",
            hostContext(host),
            { id: editingJob.id, ...input },
            CREATE_TIMEOUT_MS,
          )
        : await hostClient.request(
            "schedule.createJob",
            hostContext(host),
            input,
            CREATE_TIMEOUT_MS,
          );
      if (!response.ok) {
        pushNotification(response.error?.message ?? t("scheduleLoadFailed"), "error");
        return;
      }
      await finishCreated();
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("scheduleLoadFailed"), "error");
    } finally {
      setCreating(false);
    }
  }

  const previewRows = plan ? schedulePlanPreviewRows(plan, t, hostDefaultModelLabel) : [];
  /** 手动编辑弹窗的预填表单：AI 草稿 → 表单状态（未定字段回落到表单默认值）。 */
  const planForm = useMemo(
    () => (plan ? planToForm(plan, workspace?.cwd ?? "") : null),
    [plan, workspace],
  );
  // One required-field check drives both the missing-fields banner and the
  // confirm button, so they can never disagree about whether creation is ready.
  const missingFields = plan ? schedulePlanMissingFields(plan) : [];
  const planReady = missingFields.length === 0;

  return (
    <div className="@container flex h-full min-w-0 flex-col" data-schedule-agent-page>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
          onClick={() => handleBack()}
        >
          <ArrowLeft size={13} />
          {t("scheduleAgentBack")}
        </button>
        <span className="text-xs text-muted">{t("scheduleAgentHint")}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        {/* Conversation (70%) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:flex-[7]">
          {/* isolate: the button's z-10 stays inside this container, so the
              composer (later sibling) always paints above the scroll area. */}
          <div className="relative isolate min-h-0 flex-1">
            <div
              ref={transcriptRef}
              className="scrollbar-subtle h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-5"
            >
              {/* The same centered content column as the conversation area:
                  the shared transcript rows keep their own alignment. */}
              <div className="conversation-content-width mx-auto flex flex-col gap-5 sm:gap-6">
                {messages.length === 0 && !loadError && (
                  <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
                    <Loader2 size={13} className="animate-spin" />
                    {t("scheduleAgentAnalyzing")}
                  </div>
                )}
                {rows.map((row, index) => (
                  <div className="transcript-row" data-row-key={row.key} key={row.key}>
                    {/* The injected preamble rides the first user turn, as a
                        disclosure centered on the conversation column. */}
                    {index === 0 && row.role === "user" && preamble && (
                      <div className="flex w-full flex-col items-center">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] leading-5 text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
                          aria-expanded={preambleOpen}
                          onClick={() => setPreambleOpen((open) => !open)}
                        >
                          <Sparkles size={11} />
                          {t("scheduleAgentPreambleToggle")}
                          {preambleOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                        </button>
                        {preambleOpen && (
                          <div className="mb-1.5 w-full whitespace-pre-wrap break-words rounded-md border border-dashed border-border bg-surface px-3 py-2 text-xs leading-6 text-muted">
                            {preamble}
                          </div>
                        )}
                      </div>
                    )}
                    <TranscriptRowView
                      row={row}
                      mode={row.key === workingRowKey ? "streaming" : "static"}
                      showCaret={row.key === workingRowKey}
                      working={row.key === workingRowKey}
                      retryableTurn={undefined}
                      retryVisible={false}
                      goOnVisible={false}
                      onRetry={async () => undefined}
                      readOnly
                      userCollapsible={false}
                      userExpanded={false}
                      onToggleUser={undefined}
                    />
                  </div>
                ))}
                {running && !workingRowKey && (
                  <div className="flex items-center gap-1.5 px-1 text-xs text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    {t("scheduleAgentThinking")}
                  </div>
                )}
              </div>
            </div>

            {/* Scroll to bottom button — anchored inside the scroll area, same
              style as the chat transcript's jump-to-latest button. */}
            {showScrollToBottom && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface-raised text-muted shadow-md transition-colors hover:bg-surface-overlay hover:text-foreground"
                title={t("transcriptScrollToBottom")}
                aria-label={t("transcriptScrollToBottom")}
              >
                <ArrowDown size={15} />
              </button>
            )}
          </div>

          <div className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
            {loadError && <p className="mb-2 text-xs text-danger">{loadError}</p>}
            <div className="chat-composer-surface rounded-xl border-[1.5px] border-border bg-surface-raised p-2 shadow-sm">
              <div className="relative">
                <textarea
                  data-testid="schedule-agent-input"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  rows={3}
                  placeholder={t("scheduleAgentInputPlaceholder")}
                  className="chat-composer-input min-h-[60px] max-h-[280px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted"
                />
              </div>
              <div className="composer-toolbar flex h-8 items-center gap-2.5 px-1">
                <div className="ml-auto flex items-center gap-2.5">
                  <ModelControls />
                  <button
                    type="button"
                    title={t("composerSend")}
                    aria-label={t("composerSend")}
                    className="theme-send-control flex size-7 items-center justify-center rounded-full bg-foreground text-surface transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                    disabled={sending || running || !draft.trim()}
                    onClick={() => void send()}
                  >
                    {sending || running ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <ArrowUp size={18} strokeWidth={2.25} className="block shrink-0" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Preview：窄屏折叠成一条可展开的面板（确认按钮常驻头部）；宽屏右侧常驻。 */}
        <aside
          className="scrollbar-subtle flex max-h-[55vh] min-w-0 shrink-0 flex-col gap-3 overflow-y-auto border-t border-border p-3 @3xl:max-h-none @3xl:min-w-0 @3xl:flex-[3] @3xl:shrink @3xl:border-t-0"
          data-testid="schedule-agent-preview"
        >
          <div className="flex items-center gap-2">
            {/* 窄屏：整行折叠开关 */}
            <button
              type="button"
              onClick={() => setPreviewOpen((open) => !open)}
              aria-expanded={previewOpen}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-semibold @3xl:hidden"
            >
              {previewOpen ? (
                <ChevronUp size={13} className="shrink-0 text-muted" />
              ) : (
                <ChevronDown size={13} className="shrink-0 text-muted" />
              )}
              <span className="truncate">{t("scheduleAgentPreviewTitle")}</span>
            </button>
            <div className="hidden min-w-0 flex-1 text-sm font-semibold @3xl:block">
              {t("scheduleAgentPreviewTitle")}
            </div>
            {/* 窄屏：确认创建常驻头部，折叠时也能直接确认 */}
            {plan && (
              <button
                type="button"
                className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 @3xl:hidden"
                disabled={!planReady || creating}
                onClick={() => void handleConfirm()}
              >
                <Check size={13} />
                {creating
                  ? t("scheduleSaving")
                  : editingJob
                    ? t("scheduleAgentConfirmUpdate")
                    : t("scheduleAgentConfirm")}
              </button>
            )}
            {plan && planForm && (
              <button
                type="button"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
                title={t("scheduleEdit")}
                aria-label={t("scheduleEdit")}
                data-testid="schedule-agent-edit"
                onClick={() => setEditOpen(true)}
              >
                <Pencil size={13} />
              </button>
            )}
          </div>
          <div className={`min-h-0 flex-col gap-3 ${previewOpen ? "flex" : "hidden"} @3xl:flex`}>
          {!plan ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center">
              <CircleDashed size={20} className="text-muted" />
              <p className="text-xs text-muted">{t("scheduleAgentPreviewEmpty")}</p>
            </div>
          ) : (
            <>
              {/* Required-but-open fields are named once, above the table,
                  instead of repeating "undetermined" on every row. */}
              {missingFields.length > 0 && (
                <p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  {t("scheduleAgentMissing", {
                    fields: missingFields.map((field) => t(field)).join("、"),
                  })}
                </p>
              )}
              <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                {previewRows.map(({ label, value, fallback }) => (
                  <div key={label} className="flex items-start gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted">{t(label)}</span>
                    {/* The banner above already names every open field, so an
                        open row only carries a quiet placeholder — repeating
                        "undetermined" on the row said the same thing twice. */}
                    {value !== null ? (
                      // A defaulted value stays readable but is dimmed, so the
                      // fields the AI actually decided stand out from the ones
                      // the plugin will fill in.
                      <span className={`min-w-0 flex-1 break-all ${fallback ? "text-muted" : ""}`}>
                        {value}
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 text-warning/70">—</span>
                    )}
                  </div>
                ))}
              </div>
              {previewRows.some((row) => row.fallback) && (
                <p className="text-[11px] text-muted/75">{t("scheduleAgentDefaultsNote")}</p>
              )}

              {/* 提示词或命令预览 */}
              {plan.kind === "prompt" &&
              plan.prompt &&
              typeof plan.prompt === "string" &&
              plan.prompt.trim() ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                  <div className="text-xs font-medium text-foreground">
                    {t("scheduleFormPrompt")}
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded bg-surface p-2 text-xs leading-relaxed whitespace-pre-wrap break-words">
                    {plan.prompt}
                  </div>
                </div>
              ) : plan.kind === "command" &&
                plan.command &&
                typeof plan.command === "string" &&
                plan.command.trim() ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                  <div className="text-xs font-medium text-foreground">
                    {t("scheduleFormCommand")}
                  </div>
                  <div className="rounded bg-surface p-2 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
                    {plan.command}
                  </div>
                </div>
              ) : null}

              <button
                type="button"
                className="interface-density-control hidden h-9 w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 @3xl:flex"
                disabled={!planReady || creating}
                onClick={() => void handleConfirm()}
              >
                <Check size={13} />
                {creating
                  ? t("scheduleSaving")
                  : editingJob
                    ? t("scheduleAgentConfirmUpdate")
                    : t("scheduleAgentConfirm")}
              </button>
              <p className="text-xs text-muted">
                {editingJob ? t("scheduleAgentConfirmUpdateHint") : t("scheduleAgentConfirmHint")}
              </p>
            </>
          )}
          </div>
        </aside>
      </div>

      {/* 手动编辑弹窗：复用创建/编辑弹窗，预填当前预览草稿。保存只回写
          配置预览（不创建），正式创建仍由「确认创建」负责。 */}
      {editOpen && planForm && (
        <ScheduleJobDialog
          job={null}
          prefill={planForm}
          onClose={() => setEditOpen(false)}
          onSaveDraft={(form) => {
            const next = formToPlan(form);
            if (!next) return;
            setDraftOverride({ baseAiPlan: aiPlanKey, plan: next });
            setEditOpen(false);
          }}
        />
      )}
    </div>
  );
}
