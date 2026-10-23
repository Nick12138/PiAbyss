import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, LoaderCircle } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import {
  flattenNodes,
  subagentRoleEmoji,
  subagentRoleLabel,
  subagentStateClass,
  subagentStateLabel,
} from "./subagent-model";

/**
 * Top-bar subagent entry.
 *
 * Main session view: a pill with icon + count + word sits next to the session
 * title whenever the session has subagent runs. It reports two states only —
 * how many subagents are running, or how many finished once none run — never
 * a run name; failed/stopped runs are left out (their result cards stay in the
 * transcript). Clicking the pill opens the run list.
 *
 * Subagent view (the chat area shows one run's conversation): a
 * "主会话标题 / 子代理标题 ▾" breadcrumb segment; the chevron button re-opens
 * the run list so the user can switch to another subagent. Clicking the main
 * title (rendered by AppTopBar) returns to the main session.
 */
export function SubagentTitleMenu() {
  const t = useT();
  const status = useAppStore((s) => s.subagentsStatus);
  const activeSubagentNodeId = useAppStore((s) => s.activeSubagentNodeId);
  const setActiveSubagent = useAppStore((s) => s.setActiveSubagent);
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const contentId = useId();

  const nodes = useMemo(() => flattenNodes(status.runs), [status.runs]);
  // 只呈现「还在跑的」和「跑完的」：失败/拒绝/停止不进列表也不计数。
  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        ({ node }) =>
          node.state !== "failed" && node.state !== "rejected" && node.state !== "stopped",
      ),
    [nodes],
  );
  const runningCount = useMemo(
    () => visibleNodes.filter(({ node }) => node.state === "running").length,
    [visibleNodes],
  );
  const activeNode = useMemo(
    () => nodes.find(({ node }) => node.id === activeSubagentNodeId)?.node ?? null,
    [nodes, activeSubagentNodeId],
  );

  const openList = (nodeId: string) => {
    setOpen(false);
    setActiveSubagent(nodeId);
  };

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Anchor the dropdown below the trigger, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open || visibleNodes.length === 0) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const maxWidth = Math.min(420, Math.max(1, window.innerWidth - margin * 2));
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - maxWidth - margin),
      );
      const top = rect.bottom + gap;
      setPopoverStyle({
        left,
        top,
        maxWidth,
        maxHeight: Math.max(1, window.innerHeight - top - margin),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, visibleNodes.length, activeSubagentNodeId]);

  // Hide the trigger when the extension is missing or nothing is left to
  // browse — except while the user is inside a run's conversation, where the
  // breadcrumb must keep a way back to the run list.
  if (!status.available || (visibleNodes.length === 0 && !activeSubagentNodeId)) return null;

  // Role emoji before the breadcrumb title — same visibility rule as the run
  // list rows and the composer status line: only when the role has a glyph
  // and the display name isn't the bare role itself.
  const activeRole = activeNode?.role?.trim();
  const activeDisplayName = activeNode ? (activeNode.name ?? activeNode.label) : undefined;
  const roleEmoji =
    activeRole && activeRole !== activeDisplayName ? subagentRoleEmoji(activeRole) : undefined;

  // 收起态只有两种：有子代理在跑 → 报在跑的数量；都跑完了 → 报已完成的总数。
  // 数量写进文案（图标 + 数量 + 文字），不报子代理名字。
  const pillLabel =
    runningCount > 0
      ? t(runningCount === 1 ? "subagentsPillRunningOne" : "subagentsPillRunningMany", {
          count: runningCount,
        })
      : t(visibleNodes.length === 1 ? "subagentsPillIdleOne" : "subagentsPillIdleMany", {
          count: visibleNodes.length,
        });

  const trigger = activeSubagentNodeId ? (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={t("subagentsTitle")}
      title={t("subagentsTitle")}
      data-tauri-drag-region="false"
      className={`pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-base font-semibold leading-none transition-colors ${
        open ? "bg-surface-overlay text-foreground" : "text-foreground hover:bg-surface-overlay"
      }`}
      onClick={() => setOpen((value) => !value)}
    >
      {roleEmoji && (
        <span className="shrink-0" aria-hidden="true">
          {roleEmoji}
        </span>
      )}
      <span className="max-w-60 truncate">
        {activeNode ? (activeNode.name ?? activeNode.label) : t("subagentsTitle")}
      </span>
      {activeNode?.state === "running" && (
        <LoaderCircle size={13} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
      )}
      <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden="true" />
    </button>
  ) : (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={pillLabel}
      title={pillLabel}
      data-tauri-drag-region="false"
      data-subagents-running={runningCount > 0 ? "true" : "false"}
      className={`pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs transition-colors hover:bg-surface-overlay hover:text-foreground ${
        open ? "bg-surface-overlay" : ""
      } ${runningCount > 0 ? "text-accent" : "text-muted"}`}
      onClick={() => setOpen((value) => !value)}
    >
      {/* Running fleet: spinner + accent tone so the entry reads as "live" at
          a glance; idle keeps a quiet bot glyph and muted tone. */}
      {runningCount > 0 ? (
        <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Bot size={12} className="shrink-0" aria-hidden="true" />
      )}
      <span className="shrink-0 whitespace-nowrap tabular-nums">{pillLabel}</span>
      <ChevronDown
        size={12}
        className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        aria-hidden="true"
      />
    </button>
  );

  const popover = open ? (
    <section
      ref={popoverRef}
      id={contentId}
      className="theme-floating-surface fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
      style={popoverStyle ?? { visibility: "hidden", left: 0, top: 0 }}
      aria-label={t("subagentsTitle")}
    >
      {/* Small caption header so the floating list is self-describing even
          when detached from the trigger visually (e.g. near the screen
          edge the popover shifts and the trigger is no longer directly
          above it). Mirrors the omitted-count footer's muted styling. */}
      <div className="shrink-0 px-3 pb-0.5 pt-1.5 text-[10px] text-muted">
        {t("subagentsTitle")}
      </div>
      <div className="scrollbar-subtle min-h-0 overflow-y-auto p-2 pt-1.5">
        <ul className="flex flex-col gap-0.5">
          {visibleNodes.map(({ node, depth }) => {
            const displayName = node.name ?? node.label;
            const role = node.role?.trim();
            const localizedRole = subagentRoleLabel(role, t);
            const badge = subagentRoleEmoji(role) ?? localizedRole;
            const showRole = Boolean(badge && role !== displayName);
            const active = node.id === activeSubagentNodeId;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay ${
                    active ? "bg-surface-overlay" : ""
                  }`}
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                  title={displayName}
                  onClick={() => openList(node.id)}
                >
                  {showRole && (
                    <span
                      className="max-w-16 shrink-0 truncate text-[11px] text-muted"
                      title={t("subagentsRole", { role: localizedRole ?? "" })}
                    >
                      {badge}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {displayName}
                  </span>
                  {node.activity?.currentTool && (
                    <span className="max-w-20 truncate text-[10px] text-muted">
                      {node.activity.currentTool}
                    </span>
                  )}
                  <span
                    className={`shrink-0 ${subagentStateClass(node.state)}`}
                    aria-label={subagentStateLabel(node.state, t)}
                    title={subagentStateLabel(node.state, t)}
                  >
                    {node.state === "running" ? (
                      <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <span className="text-[10px]">{subagentStateLabel(node.state, t)}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {status.omitted > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted">
          {t("subagentsOmitted", { count: status.omitted })}
        </div>
      )}
    </section>
  ) : null;

  return (
    <>
      {activeSubagentNodeId && (
        <span className="pointer-events-none shrink-0 text-muted" aria-hidden="true">
          /
        </span>
      )}
      {trigger}
      {typeof document === "undefined" || !popoverStyle || !popover
        ? null
        : createPortal(popover, document.body)}
    </>
  );
}
