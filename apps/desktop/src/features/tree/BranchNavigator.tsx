import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import type { TreeBranchPoint } from "./tree-model";

/** Inline branch switcher for a transcript row with sibling alternatives:
 *  ‹ i/n ›, rendered in the row's action strip. Switching back to an
 *  alternative that is already rendered scrolls to it; otherwise the session
 *  leaf is rewired to the sibling branch. */
export function BranchNavigator({
  point,
  disabled,
  pending,
  onSelect,
}: {
  point: TreeBranchPoint;
  /** Locked while the agent is busy or another navigation is in flight. */
  disabled: boolean;
  /** True while this navigator's switch is in flight. */
  pending: boolean;
  onSelect: (targetId: string) => void;
}) {
  const t = useT();
  const { alternatives, activeIndex } = point;
  const prev = activeIndex > 0 ? alternatives[activeIndex - 1]! : undefined;
  const next = activeIndex < alternatives.length - 1 ? alternatives[activeIndex + 1]! : undefined;
  const goPrev = prev ? () => onSelect(prev.targetId) : undefined;
  const goNext = next ? () => onSelect(next.targetId) : undefined;
  const arrow =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-30";
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-md border border-border px-0.5 text-[10px] text-muted"
      data-branch-navigator
    >
      {pending ? (
        <LoaderCircle size={11} className="animate-spin" />
      ) : (
        <>
          <button
            type="button"
            className={arrow}
            disabled={disabled || !goPrev}
            title={t("treeBranchPrev")}
            aria-label={t("treeBranchPrev")}
            onClick={goPrev}
          >
            <ChevronLeft size={11} />
          </button>
          <span className="tabular-nums" aria-hidden="true">
            {activeIndex + 1}/{alternatives.length}
          </span>
          <button
            type="button"
            className={arrow}
            disabled={disabled || !goNext}
            title={t("treeBranchNext")}
            aria-label={t("treeBranchNext")}
            onClick={goNext}
          >
            <ChevronRight size={11} />
          </button>
        </>
      )}
    </span>
  );
}
