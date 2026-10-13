/**
 * PixiePage 的「打个盹」控件，渲染在应用顶栏。v5: the nap switches the pixie
 * workspace to a fresh standard session (pixie.newSegment); the Host promotes
 * the new runtime and pushes its session.snapshot, so the transcript swaps over
 * via the normal event flow. Gate on the active session's streaming state and
 * emptiness — the host call is idempotent and safe with nothing open, and an
 * empty session (the new-session surface) has nothing to nap on: the Host
 * no-ops it too, so the disabled state is just honest UI.
 */
import { Moon } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";

export function PixieNapButton() {
  const t = useT();
  const running = useAppStore((s) => (s.session ? !s.session.isIdle : false));
  const hostReady = useAppStore((s) => s.host !== null);
  // 新建会话界面（还没说过一句话）不支持打盹：没有可收尾的内容。
  const empty = useAppStore((s) => (s.session?.messages.length ?? 0) === 0);
  const nap = usePixieViewStore((s) => s.nap);
  const disabled = running || !hostReady || empty;
  return (
    <button
      type="button"
      data-testid="pixie-nap-button"
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled}
      title={running ? t("pixieNapHintBusy") : empty ? t("pixieNapHintEmpty") : t("pixieNapHint")}
      onClick={() => void nap()}
    >
      <Moon size={11} />
      {t("pixieNapButton")}
    </button>
  );
}
