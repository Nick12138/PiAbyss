import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { requestFork } from "../../lib/fork-actions";
import { requestTranscriptScroll } from "../../lib/transcript-navigation";
import { subscribeTreeOverlay } from "../../lib/tree-overlay";
import { flattenSessionTree } from "./tree-model";
import { SessionTreeGraph } from "./SessionTreeGraph";
import { navigateTreeTo } from "./session-tree-nav";
import { refreshSessionTree, useSessionTree } from "./tree-data";

/** Estimated average glyph width (px) at the row's 12px font, used to budget
 *  the excerpt length from the available panel width. CSS ellipsis still
 *  applies the exact pixel-level cutoff. */
const CHAR_W = 7;

/**
 * Modal session-tree surface, opened from the AppTopBar branch button or the
 * `/tree` command. Replaces the right-dock tree tab: the tree is a low-,
 * burst-frequency view, so it lives behind an on-demand overlay instead of a
 * permanent dock tab. Rows click-jump the transcript; the fork button keeps
 * the overlay open so the refreshed tree shows the new branch.
 */
export function SessionTreeOverlay() {
  const t = useT();
  const session = useAppStore((state) => state.session);
  const [open, setOpen] = useState(false);
  const [navigating, setNavigating] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const tree = useSessionTree();

  useEffect(
    () =>
      subscribeTreeOverlay(() => {
        setOpen(true);
        return true;
      }),
    [],
  );

  // Esc closes on top of the focus-trap-free portal: the overlay has no
  // form controls, so a plain key listener is enough.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Reset per-action state when the overlay (re)opens.
  useEffect(() => {
    if (open) {
      setNavigating(null);
      setForking(null);
    }
  }, [open]);

  // Width available to the text column drives the excerpt char budget so the
  // displayed message length tracks the dialog size.
  const panelRef = useRef<HTMLDivElement>(null);
  const [textWidth, setTextWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const update = () => {
      setTextWidth((width) =>
        Math.abs((width ?? 0) - element.clientWidth) > 1 ? element.clientWidth : width,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const { rows, laneCount } = useMemo(() => {
    if (!tree.tree) return { rows: [], laneCount: 1 };
    const maxChars = textWidth !== null ? Math.max(12, Math.floor(textWidth / CHAR_W)) : undefined;
    return flattenSessionTree(tree.tree, tree.leafId, maxChars);
  }, [tree.tree, tree.leafId, textWidth]);

  if (!open) return null;

  const busy = session ? !session.isIdle : true;
  const hasSession = Boolean(session);

  function onNavigate(targetId: string) {
    setOpen(false);
    if (requestTranscriptScroll({ sourceId: targetId })) return;
    setNavigating(targetId);
    void navigateTreeTo(targetId, t).finally(() => setNavigating(null));
  }

  function onFork(entryId: string) {
    setForking(entryId);
    // Default position ("before"): branch ahead of the message and restore its
    // text into the composer for editing — the dock panel's fork semantics.
    void requestFork(entryId).finally(() => setForking(null));
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-tree-title"
        className="theme-floating-surface flex max-h-[min(680px,90vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="interface-density-nav-row flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <GitBranch size={14} className="shrink-0 text-muted" />
          <span id="session-tree-title" className="text-sm font-semibold">
            {t("dockTree")}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {busy ? t("dockTreeBusy") : t("dockTreeHint")}
          </span>
          <button
            type="button"
            title={t("dockTreeRefresh")}
            aria-label={t("dockTreeRefresh")}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={refreshSessionTree}
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            title={t("commonClose")}
            aria-label={t("commonClose")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!hasSession ? (
            <p className="px-3 py-2 text-xs text-muted">{t("dockTreeNoSession")}</p>
          ) : tree.error ? (
            <p className="px-3 py-2 text-xs text-danger">{tree.error}</p>
          ) : tree.tree === null ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
              <LoaderCircle size={12} className="animate-spin" /> {t("dockTreeLoading")}
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">{t("dockTreeEmpty")}</p>
          ) : (
            <SessionTreeGraph
              rows={rows}
              laneCount={laneCount}
              navigating={navigating}
              forking={forking}
              busy={busy}
              onNavigate={onNavigate}
              onFork={onFork}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
