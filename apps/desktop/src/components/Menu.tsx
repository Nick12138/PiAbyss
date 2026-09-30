import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  closeContextMenu,
  subscribeContextMenu,
  type ContextMenuRequest,
} from "../lib/context-menu";

const VIEWPORT_PADDING = 8;

export function MenuHost() {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  useEffect(() => subscribeContextMenu(setRequest), []);
  return request ? <Menu key={request.requestId} request={request} /> : null;
}

function Menu({ request }: { request: ContextMenuRequest }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: request.x, top: request.y });

  const close = useCallback(
    (restoreFocus = true) => {
      closeContextMenu();
      if (restoreFocus && request.trigger?.isConnected) request.trigger.focus();
    },
    [request.trigger],
  );

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(
        VIEWPORT_PADDING,
        Math.min(request.x, window.innerWidth - rect.width - VIEWPORT_PADDING),
      ),
      top: Math.max(
        VIEWPORT_PADDING,
        Math.min(request.y, window.innerHeight - rect.height - VIEWPORT_PADDING),
      ),
    });
  }, [request.x, request.y]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close(false);
    };
    const onDismiss = () => close(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [close]);

  const focusByKey = (key: string) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? items.length - 1
          : key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-context-menu
      className="theme-floating-surface fixed z-[120] max-h-[calc(100vh-16px)] min-w-48 max-w-72 overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-xl"
      style={position}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          focusByKey(event.key);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {request.items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.id}>
            {item.separatorBefore && <div className="my-1 border-t border-border" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`flex min-h-8 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-control-hover focus-visible:bg-control-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger ? "text-danger" : "text-foreground"
              }`}
              onClick={() => {
                close();
                void Promise.resolve(item.onSelect()).catch(() => undefined);
              }}
            >
              {Icon ? (
                <Icon size={14} className="shrink-0" aria-hidden="true" />
              ) : (
                <span className="w-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.chordHint && (
                <kbd className="shrink-0 font-mono text-[10px] text-muted">{item.chordHint}</kbd>
              )}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
