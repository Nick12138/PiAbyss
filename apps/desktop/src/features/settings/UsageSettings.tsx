import type {
  HostResponseEnvelope,
  SerializableUsage,
  SessionUsageModelItem,
  SessionUsageReport,
  UsageRange,
} from "@piabyss/protocol";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  BarChart3,
  BrainCircuit,
  Database,
  FileInput,
  FileOutput,
  Layers3,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { SettingsTopBarActions } from "./settings-top-bar";
import { useT } from "../../lib/i18n/use-t";
import { useEffect, useMemo, useState } from "react";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { formatTokenCount } from "../../lib/format-token-count";
import { requestUsageReportWithRetry } from "./usage-report-request";

type UsageReportResponse = HostResponseEnvelope<"session.usageReport">;

let usageReportInFlight: {
  key: string;
  promise: Promise<UsageReportResponse>;
} | null = null;

function sharedUsageReportRequest(
  key: string,
  request: () => Promise<UsageReportResponse>,
): Promise<UsageReportResponse> {
  if (usageReportInFlight?.key === key) return usageReportInFlight.promise;
  const promise = requestUsageReportWithRetry(request);
  usageReportInFlight = { key, promise };
  const clear = () => {
    if (usageReportInFlight?.promise === promise) usageReportInFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

function useSessionUsageReport() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const [report, setReport] = useState<SessionUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;

  useEffect(() => {
    if (!hostInstanceId || !workspaceId || workspaceRevision === undefined) {
      setReport(null);
      setError(null);
      setLoading(false);
      return;
    }
    const current = useAppStore.getState();
    const requestHost = current.host;
    const requestWorkspace = current.workspace;
    if (
      !requestHost ||
      !requestWorkspace ||
      requestHost.hostInstanceId !== hostInstanceId ||
      requestWorkspace.id !== workspaceId ||
      requestWorkspace.revision !== workspaceRevision
    ) {
      return;
    }
    let cancelled = false;
    const expectedHostId = requestHost.hostInstanceId;
    const expectedWorkspaceId = requestWorkspace.id;
    const requestKey = `${expectedHostId}:${expectedWorkspaceId}:${requestWorkspace.revision}:${refreshKey}`;
    setLoading(true);
    setError(null);

    void sharedUsageReportRequest(requestKey, () =>
      hostClient.request(
        "session.usageReport",
        workspaceContext(requestHost, requestWorkspace),
        null,
        120_000,
      ),
    )
      .then((response) => {
        const current = useAppStore.getState();
        if (
          cancelled ||
          current.host?.hostInstanceId !== expectedHostId ||
          current.workspace?.id !== expectedWorkspaceId
        ) {
          return;
        }
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setReport(response.result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostInstanceId, workspaceId, workspaceRevision, refreshKey]);

  return {
    report,
    error,
    loading,
    refresh: () => setRefreshKey((value) => value + 1),
  };
}

function emptyUsage(): SerializableUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: SerializableUsage, value: SerializableUsage): void {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.totalTokens += value.totalTokens;
  target.cost.input += value.cost.input;
  target.cost.output += value.cost.output;
  target.cost.cacheRead += value.cost.cacheRead;
  target.cost.cacheWrite += value.cost.cacheWrite;
  target.cost.total += value.cost.total;
  if (value.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + value.reasoning;
  if (value.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + value.cacheWrite1h;
  }
}

function rangeStart(range: UsageRange): number | null {
  if (range === "all") return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (range === "7d") start.setDate(start.getDate() - 6);
  return start.getTime();
}

function filterUsageReport(report: SessionUsageReport, range: UsageRange): SessionUsageReport {
  const start = rangeStart(range);
  const sessions =
    start === null
      ? report.sessions
      : report.sessions.filter((session) => session.updatedAt >= start);
  const usage = emptyUsage();
  const models = new Map<string, SessionUsageModelItem>();
  let messageCount = 0;
  for (const session of sessions) {
    messageCount += session.messageCount;
    addUsage(usage, session.usage);
    for (const model of session.models ?? []) {
      const key = `${model.provider}/${model.modelId}`;
      const aggregate = models.get(key) ?? {
        provider: model.provider,
        providerName: model.providerName,
        modelId: model.modelId,
        sessionCount: 0,
        usage: emptyUsage(),
      };
      aggregate.sessionCount += model.sessionCount;
      addUsage(aggregate.usage, model.usage);
      models.set(key, aggregate);
    }
  }
  return {
    ...report,
    totals: { sessionCount: sessions.length, messageCount, usage },
    models:
      models.size > 0
        ? [...models.values()].sort(
            (left, right) => right.usage.totalTokens - left.usage.totalTokens,
          )
        : report.models,
    sessions,
  };
}

type TokenSegment = {
  key: "input" | "output" | "cacheRead" | "cacheWrite";
  label: string;
  value: number;
  color: string;
  icon: LucideIcon;
};

const TOKEN_COLORS = {
  input: "#60a5fa",
  output: "#a78bfa",
  cacheRead: "#34d399",
  cacheWrite: "#fbbf24",
} as const;

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: LucideIcon;
  tone: string;
}) {
  return (
    <div className="group rounded-xl border border-border bg-surface-raised/70 p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] text-muted">{label}</span>
        <span className={`flex size-8 items-center justify-center rounded-lg ${tone}`}>
          <Icon size={16} strokeWidth={1.8} />
        </span>
      </div>
      <p className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-[11px] text-muted">{detail}</p>}
    </div>
  );
}

function UsageSettingsContent({
  report,
  t,
}: {
  report: SessionUsageReport;
  t: ReturnType<typeof useT>;
}) {
  const usage = report.totals.usage;
  const segments: TokenSegment[] = [
    {
      key: "input",
      label: t("usageInput"),
      value: usage.input,
      color: TOKEN_COLORS.input,
      icon: FileInput,
    },
    {
      key: "output",
      label: t("usageOutput"),
      value: usage.output,
      color: TOKEN_COLORS.output,
      icon: FileOutput,
    },
    {
      key: "cacheRead",
      label: t("usageCacheRead"),
      value: usage.cacheRead,
      color: TOKEN_COLORS.cacheRead,
      icon: Database,
    },
    {
      key: "cacheWrite",
      label: t("usageCacheWrite"),
      value: usage.cacheWrite,
      color: TOKEN_COLORS.cacheWrite,
      icon: Layers3,
    },
  ];
  const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  const topModels = (report.models ?? []).slice(0, 5);
  const maxModelTokens = topModels[0]?.usage.totalTokens ?? 0;
  const averageTokens = report.totals.sessionCount
    ? Math.round(usage.totalTokens / report.totals.sessionCount)
    : 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label={t("usageTotalTokens")}
          value={formatTokenCount(usage.totalTokens)}
          detail={t("usageTokensTracked")}
          icon={Sparkles}
          tone="bg-blue-500/15 text-blue-300"
        />
        <MetricCard
          label={t("usageSessions")}
          value={report.totals.sessionCount.toLocaleString()}
          detail={t("usageSessionsTracked")}
          icon={Users}
          tone="bg-violet-500/15 text-violet-300"
        />
        <MetricCard
          label={t("usageMessagesTotal")}
          value={report.totals.messageCount.toLocaleString()}
          detail={t("usageMessagesTracked")}
          icon={MessageSquare}
          tone="bg-emerald-500/15 text-emerald-300"
        />
        <MetricCard
          label={t("usageAverageSession")}
          value={formatTokenCount(averageTokens)}
          detail={t("usageAverageSessionDetail")}
          icon={BarChart3}
          tone="bg-amber-500/15 text-amber-300"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.9fr)]">
        <section className="rounded-xl border border-border bg-surface-raised/70 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">{t("usageTokenMix")}</h2>
              <p className="mt-1 text-xs text-muted">{t("usageTokenMixSubtitle")}</p>
            </div>
            <Sparkles size={17} className="text-accent" aria-hidden />
          </div>
          <div
            className="mt-6 flex h-3 overflow-hidden rounded-full bg-surface-overlay"
            role="img"
            aria-label={t("usageTokenMix")}
          >
            {segments.map((segment) => (
              <span
                key={segment.key}
                className="h-full transition-[width] duration-500"
                style={{
                  width: `${percentage(segment.value, segmentTotal)}%`,
                  backgroundColor: segment.color,
                }}
                title={`${segment.label}: ${formatTokenCount(segment.value)}`}
              />
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
            {segments.map(({ key, label, value, color, icon: Icon }) => (
              <div key={key} className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
                  <Icon size={13} aria-hidden />
                  <span className="truncate">{label}</span>
                </div>
                <p className="mt-1 text-sm font-semibold tabular-nums">{formatTokenCount(value)}</p>
                <p className="text-[10px] text-muted">{percentage(value, segmentTotal)}%</p>
              </div>
            ))}
          </div>
          {usage.reasoning !== undefined && usage.reasoning > 0 && (
            <div className="mt-5 flex items-center justify-between border-t border-border pt-3 text-xs">
              <span className="flex items-center gap-1.5 text-muted">
                <BrainCircuit size={13} /> {t("usageReasoning")}
              </span>
              <span className="font-medium tabular-nums">{formatTokenCount(usage.reasoning)}</span>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-surface-raised/70 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">{t("usageTopModels")}</h2>
              <p className="mt-1 text-xs text-muted">{t("usageTopModelsSubtitle")}</p>
            </div>
            <BarChart3 size={17} className="text-accent" aria-hidden />
          </div>
          <div className="mt-5 flex flex-col gap-4">
            {topModels.length > 0 ? (
              topModels.map((model) => {
                const share = percentage(model.usage.totalTokens, maxModelTokens);
                return (
                  <ModelUsageBar
                    key={`${model.provider}/${model.modelId}`}
                    model={model}
                    providerName={model.providerName ?? t("usageUnknownProvider")}
                    share={share}
                  />
                );
              })
            ) : (
              <p className="text-xs text-muted">{t("usageModelsUnavailable")}</p>
            )}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-surface-raised/70">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-medium">{t("usageSessionBreakdown")}</h2>
            <p className="mt-1 text-xs text-muted">{t("usageSessionBreakdownSubtitle")}</p>
          </div>
          <span className="text-xs tabular-nums text-muted">
            {report.totals.sessionCount.toLocaleString()}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[38rem] table-fixed border-collapse text-left text-xs">
            <thead className="text-[11px] text-muted">
              <tr className="interface-density-table-header-row border-b border-border/70">
                <th scope="col" className="w-[42%] px-5 font-medium">
                  {t("usageColSession")}
                </th>
                <th scope="col" className="w-[23%] px-3 font-medium">
                  {t("usageColUpdated")}
                </th>
                <th scope="col" className="w-[17%] px-3 text-right font-medium">
                  {t("usageColMessages")}
                </th>
                <th scope="col" className="w-[18%] px-5 text-right font-medium">
                  {t("usageColTokens")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.sessions.map((session) => (
                <tr
                  key={session.sessionPath}
                  className="interface-density-table-row border-b border-border/70 last:border-0"
                >
                  <td className="px-5">
                    <div className="flex min-w-0 items-center gap-2">
                      {session.archived && (
                        <>
                          <Archive size={13} className="shrink-0 text-muted" aria-hidden />
                          <span className="sr-only">{t("usageArchived")}</span>
                        </>
                      )}
                      <span className="truncate font-medium" title={session.sessionPath}>
                        {session.name ?? t("usageUntitledSession")}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 text-muted">
                    {new Date(session.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 text-right tabular-nums text-muted">
                    {session.messageCount.toLocaleString()}
                  </td>
                  <td className="px-5 text-right font-medium tabular-nums">
                    {formatTokenCount(session.usage.totalTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ModelUsageBar({
  model,
  providerName,
  share,
}: {
  model: SessionUsageModelItem;
  providerName: string;
  share: number;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
          <span className="size-2 shrink-0 rounded-full bg-accent" />
          <span className="truncate" title={`${model.provider}/${model.modelId}`}>
            {model.modelId}
          </span>
          <span className="shrink-0 text-[10px] text-muted">{providerName}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted">
          {formatTokenCount(model.usage.totalTokens)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-overlay">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}

export function UsageSettings() {
  const t = useT();
  const [range, setRange] = useState<UsageRange>("today");
  const { report, error, loading, refresh } = useSessionUsageReport();
  const filteredReport = useMemo(
    () => (report ? filterUsageReport(report, range) : null),
    [report, range],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SettingsTopBarActions
        title={t("navUsage")}
        subtitle={t("usageSubtitle")}
      >
        <div
          className="flex items-center gap-1 rounded-lg border border-border bg-surface-raised p-0.5"
          role="group"
          aria-label={t("usageRangeLabel")}
        >
          {(["today", "7d", "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              aria-pressed={range === option}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                range === option
                  ? "bg-accent text-accent-foreground"
                  : "text-muted hover:bg-surface-overlay hover:text-foreground"
              }`}
            >
              {t(
                `usageRange${option === "today" ? "Today" : option === "7d" ? "SevenDays" : "All"}` as
                  "usageRangeToday" | "usageRangeSevenDays" | "usageRangeAll",
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="mr-5 flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
          title={t("usageRefresh")}
          aria-label={t("usageRefresh")}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </SettingsTopBarActions>

      <div className="min-h-0 flex-1 overflow-auto" data-settings-scroll>
        {error ? (
          <div className="m-6 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : !report && loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted">
            {t("usageLoading")}
          </div>
        ) : filteredReport?.sessions.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <BarChart3 size={28} className="opacity-40" aria-hidden />
            <span>{t("usageEmpty")}</span>
          </div>
        ) : filteredReport ? (
          <UsageSettingsContent report={filteredReport} t={t} />
        ) : null}
      </div>
    </div>
  );
}
