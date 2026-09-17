import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { ScheduleRunSummary, ScheduleTranscriptEntry } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import {
  formatDateTime,
  formatDurationMs,
} from "./schedule-model";

const TRANSCRIPT_TIMEOUT_MS = 20_000;
const REPLY_TIMEOUT_MS = 31 * 60 * 1000;

const STATUS_LABEL: Record<string, MessageKey> = {
  ok: "scheduleStatusOk",
  error: "scheduleStatusError",
  timeout: "scheduleStatusTimeout",
  aborted: "scheduleStatusAborted",
  running: "scheduleStatusRunning",
};

const TRIGGER_LABEL: Record<string, MessageKey> = {
  manual: "scheduleTriggerManual",
  once: "scheduleTriggerOnce",
  interval: "scheduleTriggerInterval",
  cron: "scheduleTriggerCron",
};

function statusTone(status: string): string {
  switch (status) {
    case "ok":
      return "text-success";
    case "running":
      return "text-accent";
    case "error":
    case "timeout":
    case "aborted":
      return "text-danger";
    default:
      return "text-muted";
  }
}

/** Execution history for one job: a run list with inline transcript expansion
 *  and a reply box (forks the run's session via the plugin). */
export function ScheduleRuns({
  runs,
  onRunsChanged,
  onError,
}: {
  runs: ScheduleRunSummary[];
  onRunsChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ScheduleTranscriptEntry[] | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPendingRunId, setReplyPendingRunId] = useState<string | null>(null);

  async function toggleRun(run: ScheduleRunSummary) {
    if (expandedRunId === run.runId) {
      setExpandedRunId(null);
      setTranscript(null);
      return;
    }
    setExpandedRunId(run.runId);
    setTranscript(null);
    if (!host) return;
    setLoadingTranscript(true);
    try {
      const response = await hostClient.request(
        "schedule.getRunTranscript",
        hostContext(host),
        { runId: run.runId },
        TRANSCRIPT_TIMEOUT_MS,
      );
      if (response.ok) {
        setTranscript(response.result.entries);
      } else {
        onError(response.error?.message ?? t("scheduleLoadFailed"));
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : t("scheduleLoadFailed"));
    } finally {
      setLoadingTranscript(false);
    }
  }

  async function sendReply(runId: string) {
    const text = replyDraft.trim();
    if (!host || !text || replyPendingRunId) return;
    setReplyPendingRunId(runId);
    try {
      const response = await hostClient.request(
        "schedule.replyToRun",
        hostContext(host),
        { runId, text },
        REPLY_TIMEOUT_MS,
      );
      if (response.ok) {
        setReplyDraft("");
        setExpandedRunId(response.result.run.runId);
        onRunsChanged();
      } else {
        onError(response.error?.message ?? t("scheduleLoadFailed"));
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : t("scheduleLoadFailed"));
    } finally {
      setReplyPendingRunId(null);
    }
  }

  if (runs.length === 0) {
    return <p className="px-1 py-3 text-xs text-muted">{t("scheduleRunsEmpty")}</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {runs.map((run) => {
        const expanded = expandedRunId === run.runId;
        return (
          <div key={run.runId} className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => void toggleRun(run)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-surface-overlay"
            >
              {expanded ? (
                <ChevronDown size={13} className="shrink-0 text-muted" />
              ) : (
                <ChevronRight size={13} className="shrink-0 text-muted" />
              )}
              <span className={`font-medium ${statusTone(run.status)}`}>
                {run.status === "running" ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 size={11} className="animate-spin" />
                    {t("scheduleStatusRunning")}
                  </span>
                ) : (
                  t(STATUS_LABEL[run.status] ?? "scheduleStatusRunning")
                )}
              </span>
              <span className="text-muted">{formatDateTime(run.startedAt)}</span>
              <span className="text-muted">· {formatDurationMs(run.durationMs)}</span>
              {run.trigger !== "manual" && run.trigger !== "reply" && (
                <span className="text-muted">· {t(TRIGGER_LABEL[run.trigger] ?? "scheduleTriggerManual")}</span>
              )}
              {run.forkOf && <span className="text-muted">· fork</span>}
              {run.usage && (
                <span className="ml-auto text-muted-foreground text-muted">
                  {run.usage.total.toLocaleString()} tok
                </span>
              )}
            </button>
            {expanded && (
              <div className="border-t border-border px-3 py-2">
                {run.summary && (
                  <p className="mb-2 line-clamp-3 text-xs text-muted">{run.summary}</p>
                )}
                {run.error && <p className="mb-2 text-xs text-danger">{run.error}</p>}
                {loadingTranscript ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    {t("scheduleTranscriptLoading")}
                  </p>
                ) : transcript !== null ? (
                  <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
                    {transcript.length === 0 ? (
                      <p className="text-xs text-muted">{t("scheduleTranscriptEmpty")}</p>
                    ) : (
                      transcript.map((entry) => (
                        <div key={entry.id} className="text-xs">
                          <span
                            className={`mr-2 font-medium ${
                              entry.role === "user"
                                ? "text-accent"
                                : entry.role === "assistant"
                                  ? "text-foreground"
                                  : "text-muted"
                            }`}
                          >
                            {entry.role}
                          </span>
                          <pre className="mt-0.5 whitespace-pre-wrap break-words font-sans text-foreground/90">
                            {entry.text}
                          </pre>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={replyDraft}
                    onChange={(event) => setReplyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        void sendReply(run.runId);
                      }
                    }}
                    placeholder={t("scheduleReplyPlaceholder")}
                    className="h-7 flex-1 rounded-md border border-border bg-surface px-2 text-xs"
                  />
                  <button
                    type="button"
                    className="theme-secondary-control inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-surface-overlay disabled:opacity-40"
                    disabled={!replyDraft.trim() || replyPendingRunId !== null}
                    onClick={() => void sendReply(run.runId)}
                  >
                    {replyPendingRunId === run.runId ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      t("scheduleReply")
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
