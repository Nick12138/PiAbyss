/**
 * SleepChip — the separator between conversation segments on PixiePage.
 * The ONLY visible trace of an underlying session switch: emoji + the
 * pixie's own sleep phrase + timestamp + why the segment ended.
 */
import { Moon, PauseCircle, Timer } from "lucide-react";
import type { PixieSegment } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";

const REASON_ICONS = {
  agent: Moon,
  user: PauseCircle,
  rollover: Timer,
} as const;

export function SleepChip({ segment }: { segment: PixieSegment }) {
  const t = useT();
  const Icon = REASON_ICONS[segment.reason ?? "agent"];
  const reasonLabel =
    segment.reason === "user"
      ? t("pixieSleepReasonUser")
      : segment.reason === "rollover"
        ? t("pixieSleepReasonRollover")
        : t("pixieSleepReasonAgent");
  return (
    <div
      data-testid="pixie-sleep-chip"
      className="my-1 flex items-center gap-2 self-center rounded-full border border-border bg-surface-raised px-3 py-1 text-[11px] text-muted"
      title={reasonLabel}
    >
      <Icon size={12} className="shrink-0" />
      <span className="max-w-[420px] truncate">
        {segment.separator ?? t("pixieSleepPhraseFallback")}
      </span>
      {segment.handoff && (
        <span className="hidden max-w-[280px] truncate border-l border-border pl-2 @md:inline">
          {segment.handoff}
        </span>
      )}
      <span className="shrink-0 text-[10px]">
        {new Date(segment.endedAt ?? segment.startedAt).toLocaleTimeString()}
      </span>
    </div>
  );
}
