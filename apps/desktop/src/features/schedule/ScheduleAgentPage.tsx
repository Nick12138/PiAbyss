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
import { ModelControls } from "../chat/ModelControls";
import { TranscriptRowView } from "../chat/Transcript";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";

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

/** Plan-config fields the preview panel understands. `null` = undetermined. */
type SchedulePlanDraft = {
  name?: string | null;
  kind?: "prompt" | "command" | null;
  prompt?: string | null;
  command?: string | null;
  cwd?: string | null;
  trigger?: Record<string, unknown> | null;
  permission?: string | null;
  model?: { provider: string; id: string } | null;
  missedWindow?: string | null;
  timeoutMs?: number | null;
  maxRuns?: number | null;
  tags?: string[] | null;
  notify?: string | null;
  loadExtensions?: boolean | null;
};

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
};

/** The first user message of a smart-creation session bundles the injected
 *  preamble and the user's requirement into one string. Split them for
 *  separate rendering. New sessions wrap the preamble in
 *  <schedule-preamble>...</schedule-preamble> sentinels; older persisted
 *  transcripts fall back to the "用户需求：" separator. */
export function splitUserMessage(text: string): SplitUserMessage {
  const open = text.indexOf("<schedule-preamble>");
  if (open >= 0) {
    const close = text.indexOf("</schedule-preamble>", open);
    if (close >= 0) {
      const before = text.slice(0, open).trim();
      const preamble = text.slice(open + "<schedule-preamble>".length, close).trim();
      const after = text
        .slice(close + "</schedule-preamble>".length)
        .replace(/^\s*用户需求[:：]\s*\n?/, "")
        .trim();
      const requirement = [before, after].filter(Boolean).join("\n").trim();
      return { preamble: preamble || null, requirement: requirement || text.trim() };
    }
  }
  const marker = "用户需求：";
  const at = text.indexOf(marker);
  if (at >= 0) {
    const preamble = text.slice(0, at).trim();
    const requirement = text.slice(at + marker.length).trim();
    if (preamble && requirement) return { preamble, requirement };
  }
  return { preamble: null, requirement: text };
}

function triggerLabel(trigger: Record<string, unknown> | null | undefined): string {
  if (!trigger || typeof trigger.type !== "string") return "";
  switch (trigger.type) {
    case "manual":
      return "手动";
    case "once":
      return `一次性 · ${String(trigger.at ?? "")}`;
    case "interval":
      return `周期 · 每 ${String(trigger.every ?? "")}`;
    case "cron":
      return `Cron · ${String(trigger.cron ?? "")}`;
    default:
      return "";
  }
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const lastMessageCountRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [preambleOpen, setPreambleOpen] = useState(false);

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

  const plan = useMemo(() => extractPlanDraft(messages), [messages]);
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
  const planReady = Boolean(
    plan &&
    typeof plan.name === "string" &&
    plan.name.trim() &&
    typeof plan.cwd === "string" &&
    plan.cwd.trim() &&
    plan.trigger &&
    typeof plan.trigger.type === "string" &&
    (plan.kind === "command" ? Boolean(plan.command?.trim()) : Boolean(plan.prompt?.trim())),
  );

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
        loadExtensions: false,
        tags: Array.isArray(plan.tags) ? plan.tags.map(String) : [],
        enabled: true,
        notify: (plan.notify ?? undefined) as ScheduleJobInput["notify"],
      };
      const response = await hostClient.request(
        "schedule.createJob",
        hostContext(host),
        input,
        CREATE_TIMEOUT_MS,
      );
      if (!response.ok) {
        pushNotification(response.error?.message ?? t("scheduleLoadFailed"), "error");
        return;
      }
      useScheduleAgentStore.getState().markCreated();
      leaveScheduleAgent();
      setPage("schedule");
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("scheduleLoadFailed"), "error");
    } finally {
      setCreating(false);
    }
  }

  const previewRows: Array<{ label: MessageKeyOf; value: string | null; fullText?: string }> = plan
    ? [
        { label: "scheduleFormName", value: plan.name ?? null },
        {
          label: "scheduleFormKind",
          value:
            plan.kind === "prompt" ? "提示词计划" : plan.kind === "command" ? "命令计划" : null,
        },
        { label: "scheduleFormCwd", value: plan.cwd ?? null },
        {
          label: "scheduleFormPermission",
          value:
            plan.permission === "read_only"
              ? "只读"
              : plan.permission === "write"
                ? "可写"
                : plan.permission === "full"
                  ? "完整"
                  : null,
        },
        {
          label: "scheduleFormModel",
          value:
            plan.model && typeof plan.model === "object"
              ? `${plan.model.provider}/${plan.model.id}`
              : null,
        },
        {
          label: "scheduleFormMissedWindow",
          value:
            plan.missedWindow === "catch_up_one"
              ? "补执行一次"
              : plan.missedWindow === "skip"
                ? "跳过"
                : null,
        },
        {
          label: "scheduleFormTimeout",
          value: plan.timeoutMs ? `${Math.round(plan.timeoutMs / 1000)}s` : null,
        },
        {
          label: "scheduleFormMaxRuns",
          value: plan.maxRuns ? String(plan.maxRuns) : null,
        },
        {
          label: "scheduleFormTags",
          value: Array.isArray(plan.tags) && plan.tags.length > 0 ? plan.tags.join(", ") : null,
        },
        {
          label: "scheduleFormNotify",
          value:
            plan.notify === "system"
              ? "系统通知"
              : plan.notify === "tg"
                ? "Telegram"
                : plan.notify === "none"
                  ? "无"
                  : null,
        },
        {
          label: "scheduleFormLoadExtensions",
          value: plan.loadExtensions === true ? "是" : plan.loadExtensions === false ? "否" : null,
        },
      ]
    : [];

  return (
    <div className="flex h-full min-w-0 flex-col" data-schedule-agent-page>
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
      <div className="flex min-h-0 flex-1">
        {/* Conversation (70%) */}
        <div className="flex min-w-0 flex-[7] flex-col">
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

        {/* Preview */}
        <aside
          className="scrollbar-subtle flex min-w-0 flex-[3] flex-col gap-3 overflow-y-auto p-3"
          data-testid="schedule-agent-preview"
        >
          <div className="text-sm font-semibold">{t("scheduleAgentPreviewTitle")}</div>
          {!plan ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center">
              <CircleDashed size={20} className="text-muted" />
              <p className="text-xs text-muted">{t("scheduleAgentPreviewEmpty")}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                {previewRows.map(({ label, value }) => (
                  <div key={label} className="flex items-start gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted">{t(label)}</span>
                    {value !== null && String(value).trim().length > 0 ? (
                      <span className="min-w-0 flex-1 break-all">{value}</span>
                    ) : (
                      <span className="flex items-center gap-1 text-muted">
                        <CircleDashed size={11} />
                        {t("scheduleAgentUndetermined")}
                      </span>
                    )}
                  </div>
                ))}
                <div className="flex items-start gap-2 text-xs">
                  <span className="w-20 shrink-0 text-muted">{t("scheduleFormTrigger")}</span>
                  {plan.trigger && typeof plan.trigger.type === "string" ? (
                    <span className="min-w-0 flex-1 break-all">{triggerLabel(plan.trigger)}</span>
                  ) : (
                    <span className="flex items-center gap-1 text-muted">
                      <CircleDashed size={11} />
                      {t("scheduleAgentUndetermined")}
                    </span>
                  )}
                </div>
              </div>

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
                className="interface-density-control flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!planReady || creating}
                onClick={() => void handleConfirm()}
              >
                <Check size={13} />
                {creating ? t("scheduleSaving") : t("scheduleAgentConfirm")}
              </button>
              <p className="text-xs text-muted">{t("scheduleAgentConfirmHint")}</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

type MessageKeyOf =
  | "scheduleFormName"
  | "scheduleFormKind"
  | "scheduleFormCwd"
  | "scheduleFormPermission"
  | "scheduleFormNotify"
  | "scheduleFormModel"
  | "scheduleFormMissedWindow"
  | "scheduleFormTimeout"
  | "scheduleFormMaxRuns"
  | "scheduleFormTags"
  | "scheduleFormLoadExtensions"
  | "scheduleFormPrompt"
  | "scheduleFormCommand";
