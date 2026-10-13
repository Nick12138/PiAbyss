/**
 * PixieBackToCurrentButton — 从历史段一键回到小精灵的当前段。
 *
 * 在会话浮层里点开某条历史会话后，页面会一直停在旧段；此按钮在
 * 「当前打开的会话 ≠ 当前段指针（pixie-store.current）」时出现于顶栏。
 * 点击：重新 ensureCurrent 拿活段（未打盹、运行阶段的会话），拿到就
 * 标准切回（openSessionAcrossWorkspaces）；拿不到（图不可用等）则落回
 * 新建会话。打盹换段时 segmentChanged 会驱动页面 re-acquire，
 * store.current 始终指向最新活段。
 */
import { Undo2 } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { createNewSession } from "../../lib/commands/actions";

export function PixieBackToCurrentButton() {
  const t = useT();
  const hostReady = useAppStore((s) => s.host !== null);
  const sessionId = useAppStore((s) => s.session?.sessionId ?? null);
  const current = usePixieViewStore((s) => s.current);
  const ensureCurrent = usePixieViewStore((s) => s.ensureCurrent);
  const refreshDispatches = usePixieViewStore((s) => s.refreshDispatches);

  // 正开着活段（或还没拿到锚点）时不需要返回。
  const visible =
    hostReady && current !== null && sessionId !== null && sessionId !== current.sessionId;
  if (!visible) return null;

  return (
    <button
      type="button"
      data-testid="pixie-back-to-current-button"
      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-foreground"
      title={t("pixieBackToCurrentTitle")}
      aria-label={t("pixieBackToCurrentTitle")}
      onClick={() => {
        void (async () => {
          const latest = await ensureCurrent();
          if (latest?.sessionId) {
            await openSessionAcrossWorkspaces({ cwd: latest.cwd, sessionId: latest.sessionId });
            // 委派面板的归属段跟随切换（与浮窗选会话同一条路径）。
            void refreshDispatches(latest.sessionId);
            return;
          }
          // 兜底：拿不到活段就回到新建会话界面。
          await createNewSession();
        })();
      }}
    >
      <Undo2 size={11} />
      {t("pixieBackToCurrentButton")}
    </button>
  );
}
