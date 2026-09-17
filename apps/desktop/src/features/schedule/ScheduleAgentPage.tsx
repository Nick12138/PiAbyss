import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CircleDashed, Loader2, Send } from "lucide-react";
import type { ScheduleJobInput } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useScheduleAgentStore } from "./schedule-agent-store";
import { leaveScheduleAgent } from "./schedule-agent-flow";

const AGENT_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 15_000;
const POLL_IDLE_MS = 2_500;
const POLL_ACTIVE_MS = 1_200;

type AgentMessage = { role: string; text: string };

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
};

/** Latest ```schedule-plan JSON from the assistant messages. */
export function extractPlanDraft(messages: AgentMessage[]): SchedulePlanDraft | null {
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
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [resident, setResident] = useState(true);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

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
      if (state.ok) {
        setResident(true);
        setRunning(state.result.running);
        setLoadError(null);
        setMessages(state.result.messages);
        return;
      }
      // Non-resident (host restarted): fall back to the persisted transcript.
      const transcript = await hostClient.request(
        "schedule.agentTranscript",
        hostContext(host),
        { sessionPath },
        AGENT_TIMEOUT_MS,
      );
      if (transcript.ok) {
        setResident(false);
        setRunning(false);
        setMessages(transcript.result.messages);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : null);
    }
  }, [sessionId, sessionPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), running ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, running]);

  // Keep the transcript scrolled to the newest message.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const plan = useMemo(() => extractPlanDraft(messages), [messages]);
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
      } else if (!resident) {
        // Continued via a fork: track the new resident session.
        useScheduleAgentStore
          .getState()
          .setSession({ sessionId: response.result.sessionId, sessionPath });
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

  const previewRows: Array<{ label: MessageKeyOf; value: string | null }> = plan
    ? [
        { label: "scheduleFormName", value: plan.name ?? null },
        { label: "scheduleFormCwd", value: plan.cwd ?? null },
        { label: "scheduleFormPermission", value: plan.permission ?? null },
        { label: "scheduleFormNotify", value: plan.notify === "system" ? "system" : null },
        {
          label: "scheduleFormModel",
          value:
            plan.model && typeof plan.model === "object"
              ? `${plan.model.provider}/${plan.model.id}`
              : null,
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
        <div className="flex min-w-0 flex-[7] flex-col border-r border-border">
          <div ref={transcriptRef} className="scrollbar-subtle flex-1 overflow-y-auto p-3">
            {messages.length === 0 && !loadError && (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
                <Loader2 size={13} className="animate-spin" />
                {t("scheduleAgentAnalyzing")}
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={index}
                className={`mb-2.5 flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[13px] ${
                    message.role === "user"
                      ? "bg-accent/15 text-foreground"
                      : "bg-surface-overlay text-foreground"
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))}
            {running && (
              <div className="flex items-center gap-1.5 px-1 text-xs text-muted">
                <Loader2 size={12} className="animate-spin" />
                {t("scheduleAgentThinking")}
              </div>
            )}
          </div>
          <div className="border-t border-border p-2.5">
            {loadError && <p className="mb-1.5 text-xs text-danger">{loadError}</p>}
            <div className="flex items-end gap-2">
              <textarea
                data-testid="schedule-agent-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={t("scheduleAgentInputPlaceholder")}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px]"
              />
              <button
                type="button"
                className="theme-primary-control inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                disabled={sending || running || !draft.trim()}
                onClick={() => void send()}
              >
                {sending || running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                {t("scheduleAgentSend")}
              </button>
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
  | "scheduleFormCwd"
  | "scheduleFormPermission"
  | "scheduleFormNotify"
  | "scheduleFormModel";
