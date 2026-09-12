import { GitFork, LoaderCircle } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import type { TreeRow } from "./tree-model";

const ROW_H = 28;
const LANE_W = 14;
const ACCENT = "var(--color-accent)";
const BASE = "var(--color-border)";

function laneX(lane: number): number {
  return lane * LANE_W + 7;
}

/** Commit-graph gutter for one fixed-height row. */
function RowRail({ row, laneCount }: { row: TreeRow; laneCount: number }) {
  const x = laneX(row.lane);
  const mid = ROW_H / 2;
  const stroke = (accent: boolean) => (accent ? ACCENT : BASE);
  return (
    <svg width={laneCount * LANE_W + 2} height={ROW_H} className="shrink-0" aria-hidden="true">
      {row.passes.map((pass) => (
        <line
          key={`pass:${pass.lane}`}
          x1={laneX(pass.lane)}
          y1={0}
          x2={laneX(pass.lane)}
          y2={ROW_H}
          stroke={stroke(pass.accent)}
          strokeWidth={1.5}
        />
      ))}
      {row.linkUp && (
        <line x1={x} y1={0} x2={x} y2={mid} stroke={stroke(row.linkUpAccent)} strokeWidth={1.5} />
      )}
      {row.linkDown && (
        <line
          x1={x}
          y1={mid}
          x2={x}
          y2={ROW_H}
          stroke={stroke(row.linkDownAccent)}
          strokeWidth={1.5}
        />
      )}
      {row.forks.map((fork) => (
        <path
          key={`fork:${fork.lane}`}
          d={`M ${x} ${mid} C ${x} ${ROW_H}, ${laneX(fork.lane)} ${mid}, ${laneX(fork.lane)} ${ROW_H}`}
          fill="none"
          stroke={stroke(fork.accent)}
          strokeWidth={1.5}
        />
      ))}
      {row.kind === "user" ? (
        <circle cx={x} cy={mid} r={4} fill={row.onPath ? ACCENT : "var(--color-muted)"} />
      ) : (
        <circle
          cx={x}
          cy={mid}
          r={3.5}
          fill="var(--color-sidebar)"
          stroke={row.onPath ? ACCENT : "var(--color-muted)"}
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

/** The git-graph row list of the session tree, shared by the overlay. */
export function SessionTreeGraph({
  rows,
  laneCount,
  navigating,
  forking,
  busy,
  onNavigate,
  onFork,
}: {
  rows: TreeRow[];
  laneCount: number;
  /** Row id a navigation is currently in flight for. */
  navigating: string | null;
  forking: string | null;
  /** True while the agent is busy; locks row actions. */
  busy: boolean;
  onNavigate: (targetId: string) => void;
  onFork: (entryId: string) => void;
}) {
  const t = useT();
  const firstUserId = rows.find((row) => row.kind === "user")?.id;
  const actionLocked = busy || navigating !== null || forking !== null;
  return (
    <>
      {rows.map((row) => (
        <div
          key={row.id}
          className={`group flex min-w-0 max-w-full h-7 items-stretch overflow-hidden pl-2 ${
            row.isCurrent ? "bg-surface-overlay/60" : "hover:bg-surface-overlay/40"
          }`}
        >
          <RowRail row={row} laneCount={laneCount} />
          <button
            type="button"
            disabled={actionLocked}
            aria-current={row.isCurrent ? "true" : undefined}
            title={row.excerpt}
            className={`flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden pl-1 text-left text-xs ${
              row.onPath ? "text-foreground" : "text-muted"
            } disabled:cursor-default`}
            onClick={() => onNavigate(row.id)}
          >
            {(navigating === row.id || forking === row.id) && (
              <LoaderCircle size={12} className="shrink-0 animate-spin" />
            )}
            <span
              className={`min-w-0 max-w-full flex-1 truncate overflow-hidden text-ellipsis whitespace-nowrap ${
                row.kind === "user" ? "font-medium" : ""
              }`}
            >
              {row.excerpt}
            </span>
            {row.label && (
              <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-muted">
                {row.label}
              </span>
            )}
            {row.isCurrent && (
              <span className="mx-[5px] shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                {t("dockTreeCurrent")}
              </span>
            )}
          </button>
          {row.kind === "user" && row.id !== firstUserId && (
            <button
              type="button"
              disabled={actionLocked}
              title={t("dockTreeFork")}
              aria-label={t("dockTreeForkFrom", { excerpt: row.excerpt })}
              className="mx-[5px] flex shrink-0 items-center justify-center px-2 text-muted hover:text-foreground disabled:opacity-40"
              onClick={() => onFork(row.id)}
            >
              <GitFork size={12} />
            </button>
          )}
        </div>
      ))}
    </>
  );
}
