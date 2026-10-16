/**
 * 随行面板里一个「可折叠分组」的外壳：一行分组头 + 展开区。
 *
 * 分组头（对齐 `docs/design/pixie-merge-C.html` 的 `.sec-head`）：
 * 折叠箭头（展开时 `rotate-90`）+ 图标 + 标题 + 计数徽章 + 右侧汇总 hint +
 * 可选的尾部小动作按钮。汇总 hint 必须**在折叠态可读**——折叠时那一行就是
 * 全部信息。展开区用项目既有的 `CollapsibleRegion`（grid-template-rows 动画）。
 *
 * 三块分组（待办 · 方寸间 / 周期计划 / 委派任务）共用这一套，加第四块只要再写
 * 一个 section 组件。
 *
 * ## 面板字号（只有四档，别再引入新值）
 *
 * 面板窄（300–640px）且信息密，字号一律用**显式 px**、不走 Tailwind 的命名档位：
 * 本应用 `:root` 是 14px，`text-xs` 实际等于 10.5px 而不是 12px，混用必然错位。
 *
 * | 档 | 类 | 用途 |
 * |---|---|---|
 * | 数字 | `text-[15px]` | 概览数字（唯一一处） |
 * | 标题 | `text-[12px]` | 分组标题（semibold）、待办标题、计划名称、速记框、表单输入 |
 * | 常规 | `text-[11px]` | 面板小标题、页签、动作按钮、详情正文、任务行、分组行、空态、说明、触发规则与倒计时 |
 * | 次级 | `text-[10px]` | 计数徽章、汇总 hint、概览标签、页签计数、日期分组头、meta、详情 dl、任务行状态与时间、徽章 |
 *
 * 取值不是新造的：11px / 10px 本来就是应用里用得最多的两档（203 处 / 97 处），
 * 12px 是第三档。改字号时请连带改这张表。
 */
import { useCallback, useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { setSidebarPref, sidebarPrefDefault } from "../../lib/sidebar-prefs";

/**
 * 分组的展开状态，按分组持久化在 `sidebarPref`（与周期计划页的分组折叠同一套）。
 * `defaultOpen` 只作用于「从没写过」的首次：待办常驻展开，周期计划 / 委派任务默认折叠。
 */
export function usePanelSection(prefKey: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => sidebarPrefDefault(prefKey, defaultOpen));
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      setSidebarPref(prefKey, next);
      return next;
    });
  }, [prefKey]);
  return [open, toggle];
}

export function PixiePanelSection({
  testId,
  icon: Icon,
  title,
  count,
  hint,
  open,
  onToggle,
  action,
  children,
}: {
  testId: string;
  icon: LucideIcon;
  title: string;
  count: number;
  /** 右侧汇总（折叠态唯一的状态信息）；空串 = 不显示。 */
  hint?: string;
  open: boolean;
  onToggle: () => void;
  /** 标题行尾部的常驻小按钮（如「＋ 新建」）。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-open={open ? "true" : "false"}
      className="shrink-0 overflow-hidden rounded-xl border border-border"
    >
      <div className="flex items-center gap-0.5 py-[5px] pl-1 pr-2">
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-[7px] rounded-md px-1.5 py-[3px] text-left transition-colors hover:bg-surface-overlay"
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={`shrink-0 text-muted transition-transform duration-150 ${
              open ? "rotate-90" : ""
            }`}
          />
          <Icon size={13} className="shrink-0 text-muted" aria-hidden="true" />
          <span className="shrink-0 text-[12px] font-semibold text-foreground">{title}</span>
          <span className="shrink-0 rounded-full bg-surface-overlay px-1.5 text-[10px] font-semibold tabular-nums text-muted">
            {count}
          </span>
          {hint ? (
            <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted">
              {hint}
            </span>
          ) : null}
        </button>
        {action}
      </div>
      <CollapsibleRegion open={open}>
        <div className="px-2 pb-2">{children}</div>
      </CollapsibleRegion>
    </section>
  );
}
