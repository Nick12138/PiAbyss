/**
 * PixieNapButton — the 「打个盹」control for the Pixie page, rendered in the app
 * top bar (mirrors MemoSyncHeaderActions placement) now that the page no longer
 * draws its own header. Reads the shared pixie view store, which the mounted
 * PixiePage keeps refreshed via polling.
 *
 * Gate on `running` only (plus "no state at all" = pixie feature off or
 * unreachable). `!state.resident` means "no live segment in Host memory" — that
 * is exactly the state in which the Host resumes the segment from the timeline
 * on `pixie.newSegment`, so blocking the click there left the button
 * permanently dead after a Host restart and after every nap. The host call is
 * idempotent and safe with nothing open, so the tooltip explains instead of
 * disabling.
 */
import { Moon } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { usePixieViewStore } from "./pixie-store";

export function PixieNapButton() {
  const t = useT();
  const hasState = usePixieViewStore((s) => s.state !== null);
  const resident = usePixieViewStore((s) => s.state?.resident ?? false);
  const running = usePixieViewStore((s) => s.state?.running ?? false);
  const nap = usePixieViewStore((s) => s.nap);
  return (
    <button
      type="button"
      data-testid="pixie-nap-button"
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={running || !hasState}
      title={
        running
          ? t("pixieNapHintBusy")
          : hasState && !resident
            ? t("pixieNapHintAsleep")
            : t("pixieNapHint")
      }
      onClick={() => void nap()}
    >
      <Moon size={11} />
      {t("pixieNapButton")}
    </button>
  );
}
