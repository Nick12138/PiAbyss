/**
 * 随行面板的**页签栏**与每块页签下面的内容外壳。
 *
 * 三块（待办 · 速记 / 自动化 / 委派任务）横着排，一次只看一块——取代原来的竖排「可折叠
 * 分组」栈：那三行分组头一共 84px 全是导航，却只有一块能放内容。现在导航只有这一行
 * 一行（`h-10` = 35px），且它上面不再有别的东西（面板标题「随行面板」已删，它的名字留给 `aria-label`）。
 *
 * 未选中的那块**不卸载**，只把显示摘掉（`hidden`）：切回去不用重新拉 `memo.list` /
 * `automation.listJobs`，也不会丢掉「列表摊开到哪条、勾选了哪几条、当前是哪个二级页签」。
 * 计数徽章常驻在页签上、要一直跟着数据走，所以三块的数据都得活着。
 *
 * **选中不换字重**：三格都是 `font-medium`，只有颜色与 2px 下划线跟着选中走。
 * 改字重（`font-semibold`）会连带改掉字宽——标题里那个「·」和整串文案一起变宽变窄，
 * 三格等分、文案居中，于是切页签时那一行看起来在「挪位」。要强调选中，加色块或加下划线，
 * 不要动 weight / letter-spacing。
 *
 * 尺寸口径：栏高 `h-10`（35px，不是 40px），三格 `flex-1` 等分。面板最窄 350px → 每格 ~113px，
 * 图标 13 + 间距 5 + 标题（11px 四字 ≈ 44）+ 间距 4 + 计数 ≈ 8 + 左右内缩 16 ≈ 90，
 * 放得下。英文标题（"Scheduled Tasks"）放不下，靠 `truncate` 截断、`title` 给全称。
 *
 * ## 面板字号（只有四档，别再引入新值）
 *
 * 面板窄（350–720px）且信息密，字号一律用**显式 px**、不走 Tailwind 的命名档位：
 * 本应用 `:root` 是 14px，`text-xs` 实际等于 10.5px 而不是 12px，混用必然错位。
 *
 * 同一条口径也管**高度**：Tailwind 的间距档位是 rem（`--spacing: 0.25rem`），在这 14px
 * 根字号下要按 `px = 档位 × 3.5` 折——`h-7` 是 24.5px 不是 28px，`h-10` 是 35px 不是 40px。
 * 按 16px 心算会一路算错（本文件曾经就这么写着「32px」）。
 *
 * | 档 | 类 | 用途 |
 * |---|---|---|
 * | 数字 | `text-[15px]` | 概览数字（唯一一处） |
 * | 标题 | `text-[12px]` | 待办标题、计划名称、速记框、表单输入 |
 * | 常规 | `text-[11px]` | 页签、面板小标题、动作按钮、详情正文、任务行、分组行、空态、说明、触发规则与倒计时 |
 * | 次级 | `text-[10px]` | 页签计数、汇总 hint、概览标签、日期分组头、meta、详情 dl、任务行状态与时间、徽章 |
 *
 * 取值不是新造的：11px / 10px 本来就是应用里用得最多的两档（203 处 / 97 处），
 * 12px 是第三档。改字号时请连带改这张表。
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type PixiePanelTabId = "todo" | "automation" | "dispatch";

export type PixiePanelTab = {
  id: PixiePanelTabId;
  icon: LucideIcon;
  title: string;
  /** 页签右侧的计数；由各块通过 `onCount` 报上来（数据仍住在块里）。 */
  count: number;
};

export function PixiePanelTabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: PixiePanelTab[];
  active: PixiePanelTabId;
  onSelect: (id: PixiePanelTabId) => void;
}) {
  return (
    <div
      role="tablist"
      data-pixie-panel-content
      data-testid="pixie-panel-tabs"
      className="flex h-10 shrink-0 items-stretch gap-1 border-b border-border px-1"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`pixie-panel-tab-${tab.id}`}
            data-testid={`pixie-panel-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`pixie-panel-${tab.id}`}
            title={tab.title}
            onClick={() => onSelect(tab.id)}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1 text-[11px] font-medium transition-colors focus-visible:outline-none ${
              selected
                ? "text-foreground shadow-[inset_0_-2px_0_var(--color-accent)]"
                : "text-muted hover:text-foreground"
            }`}
          >
            <Icon size={13} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{tab.title}</span>
            <span className="shrink-0 text-[10px] tabular-nums opacity-75">{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 一块页签的内容：`px-3` 与面板左缘对齐，`hint` / `action` 给的话先画一行工具条
 * （待办 · 速记不用这两个参数——它那一行是「待处理 / 已完成」二级页签，自己画）。
 *
 * 隐藏同时挂 `hidden` 属性与 `.hidden` 类：属性给可访问性与测试用，类负责真的
 * `display:none`（Tailwind 的 utilities 层排在 preflight 之后，光靠属性会被这里的
 * `flex` 顶掉）。
 */
export function PixiePanelBody({
  tab,
  active,
  hint,
  action,
  children,
}: {
  tab: PixiePanelTabId;
  active: boolean;
  /** 这一块的汇总（原折叠态唯一的状态信息）；空串 = 不画工具条。 */
  hint?: string;
  /** 工具条尾部的小按钮（如「＋ 新建」）。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={`pixie-panel-${tab}`}
      data-testid={`pixie-panel-body-${tab}`}
      data-active={active ? "true" : "false"}
      role="tabpanel"
      aria-labelledby={`pixie-panel-tab-${tab}`}
      hidden={!active}
      className={`${active ? "flex flex-col gap-2" : "hidden"} shrink-0 px-3 pb-2.5 pt-2`}
    >
      {hint || action ? (
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[10px] tabular-nums text-muted">
            {hint}
          </span>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
