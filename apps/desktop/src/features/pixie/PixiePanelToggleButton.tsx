/**
 * 小精灵页顶栏的「随行面板」开关。
 *
 * 与 chat 页的 `DockToggleButton` 同位置、同尺寸（`size-7`），但管的是完全不同的
 * 东西——那个管工作区 dock（文件 / 终端 / 改动），这个管小精灵的随行面板，所以
 * 不复用、也不共用状态。
 *
 * 行宽不足 672（`PIXIE_PANEL_BREAKPOINT_PX`）时面板自动收起，此时这个开关没有意义：
 * `pixiePanelWide` 由面板量出行了宽后写进 store，为 false 时直接不渲染。
 */
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

export function PixiePanelToggleButton() {
  const t = useT();
  const open = useAppStore((state) => state.pixiePanelOpen);
  const wide = useAppStore((state) => state.pixiePanelWide);
  const setPixiePanelOpen = useAppStore((state) => state.setPixiePanelOpen);

  if (!wide) return null;

  const label = open ? t("pixiePanelCollapse") : t("pixiePanelExpand");

  return (
    <button
      type="button"
      data-testid="pixie-panel-toggle"
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls="pixie-side-panel"
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
      onClick={() => setPixiePanelOpen(!open)}
    >
      {open ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
    </button>
  );
}
