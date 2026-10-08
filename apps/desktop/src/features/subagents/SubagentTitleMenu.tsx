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
 * Main session view: a bot-icon button with a running-count badge appears
 * next to the session title whenever the session has subagent runs; clicking
 * it opens the run list.
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
  const runningCount = useMemo(
    () => nodes.filter(({ node }) => node.state === "running").length,
    [nodes],
  );
  const failedCount = useMemo(
    () => nodes.filter(({ node }) => node.state === "failed" || node.state === "rejected").length,
    [nodes],
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
    if (!open || nodes.length === 0) return;
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
  }, [open, nodes.length, activeSubagentNodeId]);

  // Hide the trigger when the extension is missing or no run exists — the
  // top-bar title stays clean when there is nothing to browse.
  if (!status.available || nodes.length === 0) return null;

  const trigger = activeSubagentNodeId ? (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={t("subagentsTitle")}
      title={t("subagentsTitle")}
      data-tauri-drag-region="false"
      className={`pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-base font-semibold leading-5 transition-colors ${
        open ? "bg-surface-overlay text-foreground" : "text-foreground hover:bg-surface-overlay"
      }`}
      onClick={() => setOpen((value) => !value)}
    >
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
      aria-label={t("subagentsTitle")}
      title={t("subagentsTitle")}
      data-tauri-drag-region="false"
      data-subagents-running={runningCount > 0 ? "true" : "false"}
      className={`pointer-events-auto relative flex size-7 items-center justify-center rounded-md transition-colors ${
        open
          ? "bg-accent/15 text-accent"
          : runningCount > 0
            ? "text-accent hover:bg-accent/15"
            : failedCount > 0
              ? "text-danger hover:bg-danger/15"
              : "text-muted hover:bg-surface-overlay hover:text-foreground"
      }`}
      onClick={() => setOpen((value) => !value)}
    >
      {/* Running fleet: accent tone + a gentle breathing animation so the
          entry reads as "live" at a glance; failures pin a danger tone;
          idle stays muted and quiet. */}
      <Bot size={15} className={runningCount > 0 ? "animate-pulse" : undefined} />
      {runningCount > 0 ? (
        <span
          className="absolute -right-1 -top-1 flex min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-medium leading-3.5 text-white"
          aria-hidden="true"
        >
          {runningCount}
        </span>
      ) : failedCount > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-danger"
          aria-hidden="true"
        />
      ) : null}
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
      {/* No header row: the list opens directly under the top-bar trigger,
          so a "子代理" caption would only repeat what the trigger already
          says; the trigger's badge carries the running count. */}
      <div className="scrollbar-subtle min-h-0 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">
          {nodes.map(({ node, depth }) => {
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
