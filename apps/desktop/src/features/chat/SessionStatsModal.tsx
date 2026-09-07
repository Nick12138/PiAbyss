import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { SessionStatsSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";
import { requestExport, type ExportFormat } from "../../lib/export-actions";
import { userErrorMessage } from "../../lib/notify-operation-error";
import { useT } from "../../lib/i18n/use-t";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </>
  );
}

export function SessionStatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const [stats, setStats] = useState<SessionStatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;

  useEffect(() => {
    if (!open) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) return;
    let cancelled = false;
    setStats(null);
    setError(null);
    const generation = captureRequestGeneration(current.host);
    void hostClient
      .request(
        "session.getStats",
        activeSessionContext(current.host, current.workspace, current.session),
        null,
      )
      .then((res) => {
        if (cancelled) return;
        if (
          !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
            session: true,
          })
        ) {
          return;
        }
        if (!res.ok) {
          setError(localizeHostError(res.error, t));
          return;
        }
        setStats(res.result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(userErrorMessage(err, t("statsLoadFailed")));
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostInstanceId, workspaceId, workspaceRevision, sessionId, sessionRevision, t]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const tokens = stats?.tokens;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-stats-title"
        className="theme-floating-surface w-full max-w-md rounded-xl border border-border bg-surface-raised p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="session-stats-title" className="truncate text-base font-semibold">
              {session?.name?.trim() || t("statsTitleFallback")}
            </h2>
            {sessionId && (
              <p className="truncate text-[11px] text-muted" title={sessionId}>
                {sessionId}
              </p>
            )}
          </div>
          <button
            type="button"
            title={t("commonClose")}
            aria-label={t("commonClose")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : !stats ? (
          <p className="text-sm text-muted">{t("statsLoading")}</p>
        ) : (
          <div className="flex flex-col text-xs leading-5">
            <span className="mb-1 text-[10px] font-medium uppercase text-muted">
              {t("statsMessages")}
            </span>
            <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5">
              <StatRow label={t("statsTotal")} value={String(stats.messageCount)} />
              {stats.userMessageCount !== undefined && (
                <StatRow label={t("statsUser")} value={String(stats.userMessageCount)} />
              )}
              {stats.assistantMessageCount !== undefined && (
                <StatRow label={t("statsAssistant")} value={String(stats.assistantMessageCount)} />
              )}
              {stats.toolCallCount !== undefined && (
                <StatRow label={t("statsToolCalls")} value={String(stats.toolCallCount)} />
              )}
              {stats.toolResultCount !== undefined && (
                <StatRow label={t("statsToolResults")} value={String(stats.toolResultCount)} />
              )}
            </div>
            {tokens && (
              <>
                <span className="mb-1 mt-3 text-[10px] font-medium uppercase text-muted">
                  {t("statsTokens")}
                </span>
                <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5">
                  <StatRow label={t("usageInput")} value={formatTokenCount(tokens.input)} />
                  <StatRow label={t("usageOutput")} value={formatTokenCount(tokens.output)} />
                  <StatRow label={t("usageCacheRead")} value={formatTokenCount(tokens.cacheRead)} />
                  <StatRow
                    label={t("usageCacheWrite")}
                    value={formatTokenCount(tokens.cacheWrite)}
                  />
                  <StatRow label={t("statsTotal")} value={formatTokenCount(tokens.total)} />
                </div>
              </>
            )}
            {stats.cost !== undefined && (
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-6">
                <span className="text-[10px] font-medium uppercase text-muted">
                  {t("statsCost")}
                </span>
                <span className="tabular-nums">{usd.format(stats.cost)}</span>
              </div>
            )}
            {stats.sessionFile && (
              <p className="mt-3 truncate text-[11px] text-muted" title={stats.sessionFile}>
                {stats.sessionFile}
              </p>
            )}
            <p className="mt-3 text-[10px] text-muted">{t("statsFootnote")}</p>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground/85 transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            disabled={exporting !== null || !session?.isIdle}
            onClick={() => {
              setExporting("jsonl");
              void requestExport("jsonl").finally(() => setExporting(null));
            }}
          >
            {exporting === "jsonl" ? t("statsExporting") : t("statsExportJsonl")}
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={exporting !== null || !session?.isIdle}
            onClick={() => {
              setExporting("html");
              void requestExport("html").finally(() => setExporting(null));
            }}
          >
            {exporting === "html" ? t("statsExporting") : t("statsExportHtml")}
          </button>
        </div>
      </div>
    </div>
  );
}
