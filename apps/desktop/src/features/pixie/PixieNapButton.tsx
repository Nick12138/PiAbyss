/**
 * PixieNapButton — the 「打个盹」control for the Pixie page, rendered in the app
 * top bar. v5: the nap switches the pixie workspace to a fresh standard
 * session (pixie.newSegment); the Host promotes the new runtime and pushes its
 * session.snapshot, so the transcript swaps over via the normal event flow.
 * Gate on the active session's streaming state only — the host call is
 * idempotent and safe with nothing open.
 */
import { Moon } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";

export function PixieNapButton() {
  const t = useT();
  const running = useAppStore((s) => s.session ? !s.session.isIdle : false);
  const hostReady = useAppStore((s) => s.host !== null);
  const nap = usePixieViewStore((s) => s.nap);
  return (
    <button
      type="button"
      data-testid="pixie-nap-button"
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={running || !hostReady}
      title={running ? t("pixieNapHintBusy") : t("pixieNapHint")}
      onClick={() => void nap()}
    >
      <Moon size={11} />
      {t("pixieNapButton")}
    </button>
  );
}
