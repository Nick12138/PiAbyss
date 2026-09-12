/**
 * Session stats under the composer (centered, after DSH), split into two icon
 * pills: a gauge pill labelled with the output speed opening the
 * time-and-speed dialog (turn/step counts live in the dialog), and a target
 * pill labelled with the cache-hit percentage opening the token-usage dialog.
 * Both dialogs share one exclusive slot — opening either pill closes the
 * other. The pills fetch `session.getStats` on mount and refetch when a run
 * settles, so the labels ride the durable whole-history aggregates (LLM/tool
 * wall time, exact token buckets, persisted TTFT/decode) and survive
 * restarts and session switches; the live-measured stream timings are the
 * fallback while nothing has been persisted yet.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Crosshair, Gauge } from "lucide-react";
import type { SessionStatsSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { userErrorMessage } from "../../lib/notify-operation-error";
import {
  billedInputTokens,
  derivePillStats,
  formatCacheHitPercent,
  formatDuration,
  outputTokensPerSecond,
  type FoldedUsage,
} from "./stats-format";

/** Exact integer token count with digit grouping. */
function exactTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </>
  );
}

/**
 * Fetch the session stats snapshot for the pill labels and dialogs; refetches
 * on mount, identity change, and idle flips (a settled run refreshes the
 * durable aggregates). Mid-stream revisions do not refetch — the labels fall
 * back to the live-measured timings while streaming.
 */
function useSessionStats(enabled: boolean): {
  stats: SessionStatsSnapshot | null;
  error: string | null;
} {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const [stats, setStats] = useState<SessionStatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const isIdle = session?.isIdle ?? true;

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, hostInstanceId, workspaceId, workspaceRevision, sessionId, isIdle, t]);

  return { stats, error };
}

export function SessionStatsPills() {
  const t = useT();
  const session = useAppStore((s) => s.session);
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const stats = useMemo(() => derivePillStats(messages), [messages]);
  const [openPill, setOpenPill] = useState<"time" | "usage" | null>(null);

  const hasTokens = billedInputTokens(stats.usage) > 0 || stats.usage.output > 0;
  const visible = stats.steps > 0 || hasTokens;
  const { stats: fetched, error: fetchError } = useSessionStats(visible);

  if (!visible) return null;

  // Pill labels ride the durable whole-history aggregates when fetched,
  // falling back to the live-measured visible snapshot while streaming.
  const hostDecodeMs = fetched?.timing?.decodeMs ?? 0;
  const hostDecodeTokens = fetched?.timing?.decodeTokens ?? 0;
  const tps =
    hostDecodeMs > 0 ? hostDecodeTokens / (hostDecodeMs / 1_000) : outputTokensPerSecond(stats);
  const dialogUsage: FoldedUsage = fetched?.tokens
    ? {
        input: fetched.tokens.input,
        output: fetched.tokens.output,
        cacheRead: fetched.tokens.cacheRead,
        cacheWrite: fetched.tokens.cacheWrite,
      }
    : stats.usage;
  const dialogTotal = billedInputTokens(dialogUsage) + dialogUsage.output;
  const cacheHit = formatCacheHitPercent(dialogUsage.cacheRead, billedInputTokens(dialogUsage));

  // A pill carries no meaning without its figure, so it is dropped whole —
  // icon included — rather than shown as a bare or zero reading.
  const timeLabel =
    tps !== null && tps > 0 ? t("statsTokensPerSecond", { tps: Math.round(tps) }) : null;
  const usageLabel = cacheHit !== null && cacheHit !== "0" ? `${cacheHit}%` : null;
  if (timeLabel === null && usageLabel === null) return null;

  return (
    <PillRow
      openPill={openPill}
      setOpenPill={setOpenPill}
      timeLabel={timeLabel}
      timeTitle={t("statsPillSessionTitle")}
      usageLabel={usageLabel}
      usageTitle={t("statsPillUsageTitle")}
      live={stats}
      fetched={fetched}
      fetchError={fetchError}
      dialogUsage={dialogUsage}
      dialogTotal={dialogTotal}
    />
  );
}

type PillRowProps = {
  openPill: "time" | "usage" | null;
  setOpenPill: (pill: "time" | "usage" | null) => void;
  /** The time pill's outer reading — the output speed only; null hides the
   * whole pill (nothing decoded yet). */
  timeLabel: string | null;
  timeTitle: string;
  /** The usage pill's outer reading — the cache-hit percentage only; null
   * hides the whole pill (no prompt input or a zero hit). */
  usageLabel: string | null;
  usageTitle: string;
  live: ReturnType<typeof derivePillStats>;
  fetched: SessionStatsSnapshot | null;
  fetchError: string | null;
  dialogUsage: FoldedUsage;
  dialogTotal: number;
};

/** One exclusive slot for both dialogs: opening either pill closes the other,
 * outside pointerdown and Escape close both. */
function PillRow({
  openPill,
  setOpenPill,
  timeLabel,
  timeTitle,
  usageLabel,
  usageTitle,
  live,
  fetched,
  fetchError,
  dialogUsage,
  dialogTotal,
}: PillRowProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openPill === null) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpenPill(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPill(null);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openPill, setOpenPill]);

  // No top padding: the composer above trims its own bottom padding to the
  // same exact 5px when this row is present (see the `:has(+ …)` rule in
  // styles/index.css), so the icons sit centered between input box and edge.
  // The arbitrary `[5px]` keeps that exact under the 14px root font size,
  // where Tailwind's rem-based spacing scale would land on 4.375px.
  return (
    <div
      ref={containerRef}
      className="relative flex items-center justify-center gap-2.5 px-1 pb-[5px]"
      data-composer-stats
    >
      {timeLabel !== null && (
        <span className="relative flex items-center">
          <PillButton
            open={openPill === "time"}
            onClick={() => setOpenPill(openPill === "time" ? null : "time")}
            title={timeTitle}
            label={timeLabel}
          >
            <Gauge size={13} className="shrink-0" aria-hidden />
          </PillButton>
          {openPill === "time" && (
            <PillPanel title={timeTitle}>
              {fetchError ? (
                <span className="text-danger">{fetchError}</span>
              ) : !fetched ? (
                <span className="text-muted">{t("statsLoading")}</span>
              ) : (
                <TimePanelRows fetched={fetched} live={live} t={t} />
              )}
            </PillPanel>
          )}
        </span>
      )}
      {usageLabel !== null && (
        <span className="relative flex items-center">
          <PillButton
            open={openPill === "usage"}
            onClick={() => setOpenPill(openPill === "usage" ? null : "usage")}
            title={usageTitle}
            label={usageLabel}
          >
            <Crosshair size={13} className="shrink-0" aria-hidden />
          </PillButton>
          {openPill === "usage" && (
            <PillPanel title={usageTitle} value={exactTokens(dialogTotal)}>
              {fetchError ? <span className="text-danger">{fetchError}</span> : null}
              <UsagePanelRows usage={dialogUsage} t={t} />
            </PillPanel>
          )}
        </span>
      )}
    </div>
  );
}

/** Time-and-speed dialog rows: turn/step counts first, then the durable
 * whole-history aggregates from the host (LLM/tool wall time plus persisted
 * TTFT/decode), falling back to the live-measured stream timestamps. */
function TimePanelRows({
  fetched,
  live,
  t,
}: {
  fetched: SessionStatsSnapshot;
  live: ReturnType<typeof derivePillStats>;
  t: Translate;
}) {
  const llmMs = fetched.timing?.llmMs ?? 0;
  const toolMs = fetched.timing?.toolMs ?? 0;
  const hostTtftSteps = fetched.timing?.ttftSteps ?? 0;
  const hostTtftMs = fetched.timing?.ttftMs ?? 0;
  const hostDecodeMs = fetched.timing?.decodeMs ?? 0;
  const hostDecodeTokens = fetched.timing?.decodeTokens ?? 0;
  const ttft =
    hostTtftSteps > 0
      ? { ms: hostTtftMs, steps: hostTtftSteps }
      : live.ttftSteps > 0
        ? { ms: live.ttftMs, steps: live.ttftSteps }
        : null;
  const tps =
    hostDecodeMs > 0 ? hostDecodeTokens / (hostDecodeMs / 1_000) : outputTokensPerSecond(live);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
      <StatRow label={t("statsDialogTurns")} value={String(live.turns)} />
      <StatRow label={t("statsDialogSteps")} value={String(live.steps)} />
      {llmMs > 0 && <StatRow label={t("statsDialogModelTime")} value={formatDuration(llmMs)} />}
      {toolMs > 0 && <StatRow label={t("statsDialogToolTime")} value={formatDuration(toolMs)} />}
      {ttft !== null && (
        <StatRow label={t("statsDialogTtft")} value={formatDuration(ttft.ms / ttft.steps)} />
      )}
      {tps !== null && (
        <StatRow
          label={t("statsDialogAvgSpeed")}
          value={t("statsTokensPerSecond", { tps: Math.round(tps) })}
        />
      )}
    </div>
  );
}

/** Token-usage dialog rows under the title's exact total. */
function UsagePanelRows({ usage, t }: { usage: FoldedUsage; t: Translate }) {
  const promptTokens = billedInputTokens(usage);
  const cacheHit = formatCacheHitPercent(usage.cacheRead, promptTokens);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
      {cacheHit !== null && <StatRow label={t("statsDialogCacheHit")} value={`${cacheHit}%`} />}
      <StatRow label={t("statsDialogUncachedInput")} value={exactTokens(usage.input)} />
      <StatRow label={t("usageCacheRead")} value={exactTokens(usage.cacheRead)} />
      {usage.cacheWrite !== 0 && (
        <StatRow label={t("usageCacheWrite")} value={exactTokens(usage.cacheWrite)} />
      )}
      <StatRow label={t("usageOutput")} value={exactTokens(usage.output)} />
    </div>
  );
}

function PillButton({
  open,
  onClick,
  title,
  label,
  children,
}: {
  open: boolean;
  onClick: () => void;
  title: string;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onClick}
      className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
    >
      {children}
      {label !== null && label !== "" && (
        <span className="flex items-center tabular-nums">{label}</span>
      )}
    </button>
  );
}

function PillPanel({
  title,
  value,
  children,
}: {
  title: string;
  /** Exact aggregate shown right of the title, matching DSH's titleValue. */
  value?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="theme-floating-surface absolute bottom-full left-1/2 z-30 mb-1 flex w-72 -translate-x-1/2 flex-col gap-y-1 rounded-md border border-border bg-surface-raised p-3 text-left text-[11px] leading-5 shadow-lg"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{title}</span>
        {value !== undefined && <span className="tabular-nums">{value}</span>}
      </span>
      <span className="mb-1 h-px bg-border" aria-hidden />
      {children}
    </div>
  );
}
