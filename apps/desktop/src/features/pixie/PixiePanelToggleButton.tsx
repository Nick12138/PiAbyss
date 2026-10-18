/**
 * 小精灵页顶栏的「随行面板」开关。
 *
 * 与 chat 页的 `DockToggleButton` 同位置、同尺寸（`size-7`），但管的是完全不同的
 * 东西——那个管工作区 dock（文件 / 终端 / 改动），这个管小精灵的随行面板，所以
 * 不复用、也不共用状态。
 *
 * 一个按钮管两种形态：行宽够（≥ `PIXIE_PANEL_BREAKPOINT_PX`）时开的是**并排的
 * 一栏**（`pixiePanelOpen`），行宽不够时开的是**盖住整个消息界面的整页抽屉**
 * （`pixiePanelDrawerOpen`）。以前窄容器下这个开关直接不渲染——那时面板在窄窗口
 * 里根本没有别的入口，方寸间 / 周期计划 / 委派任务全部打不开；面板成为方寸间的
 * 唯一去处之后，这里必须留着。图标也按形态换：抽屉用 `PanelRight`，与并排的
 * 开合箭头区分开。
 */
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

export function PixiePanelToggleButton() {
  const t = useT();
  const open = useAppStore((state) => state.pixiePanelOpen);
  const wide = useAppStore((state) => state.pixiePanelWide);
  const drawerOpen = useAppStore((state) => state.pixiePanelDrawerOpen);
  const setPixiePanelOpen = useAppStore((state) => state.setPixiePanelOpen);
  const setPixiePanelDrawerOpen = useAppStore((state) => state.setPixiePanelDrawerOpen);

  const shown = wide ? open : drawerOpen;
  const label = shown ? t("pixiePanelCollapse") : t("pixiePanelExpand");
  // 开合一律用同一对箭头，与 chat 页的 `DockToggleButton` 保持同一口径：展开态给
  // 收起图标、收起态给展开图标。抽屉形态过去用一块静态的 `PanelRight`，两种形态
  // 方向对不上——用户在同一颗按钮上看到的语义不该随窗口宽度变。
  const Icon = shown ? PanelRightClose : PanelRightOpen;

  return (
    <button
      type="button"
      data-testid="pixie-panel-toggle"
      data-panel-drawer={wide ? undefined : "true"}
      title={label}
      aria-label={label}
      aria-expanded={shown}
      aria-controls="pixie-side-panel"
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
      onClick={() => (wide ? setPixiePanelOpen(!open) : setPixiePanelDrawerOpen(!drawerOpen))}
    >
      <Icon size={15} />
    </button>
  );
}
