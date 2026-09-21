import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface SelectOption {
  value: string;
  label: ReactNode;
  /** Optional group header; rendered above the first option of each group
   *  (like the chat model menu's provider headers). */
  group?: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  align?: "left" | "right";
  maxWidth?: number;
  /** Borderless inline style (for toolbars embedded in another control). */
  ghost?: boolean;
  /** Pinned below the option list inside the menu surface (scrolls separately,
   *  stays visible while the list scrolls). Clicks inside never close the menu. */
  footer?: ReactNode;
  /** Overrides the trigger's displayed text (e.g. to append extra state like
   *  the thinking depth); the menu options are unaffected. */
  selectedLabel?: ReactNode;
}

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  className = "",
  triggerClassName = "",
  align = "left",
  maxWidth,
  ghost = false,
  footer,
  selectedLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({
    top: 0,
    left: 0,
    minWidth: 0,
    maxHeight: 240,
    opensUpward: false,
  });
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);

  // Precompute group-header placement: a header row shows before the first
  // option of each distinct group (undefined group = no header).
  const groupHeaders = new Map<string, string>();
  let lastGroup: string | undefined;
  for (const option of options) {
    if (option.group !== undefined && option.group !== lastGroup) {
      groupHeaders.set(option.value, option.group);
    }
    lastGroup = option.group;
  }

  useLayoutEffect(() => {
    if (!open) return;

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gutter = 8;
      const preferredHeight = 240;
      const below = Math.max(0, window.innerHeight - rect.bottom - gutter);
      const above = Math.max(0, rect.top - gutter);
      const opensUpward = below < 160 && above > below;
      const available = opensUpward ? above : below;
      const maxHeight = Math.max(1, Math.min(preferredHeight, available || preferredHeight));
      const width = rect.width;
      const preferredLeft = align === "right" ? rect.right - width : rect.left;
      const left = Math.max(gutter, Math.min(preferredLeft, window.innerWidth - width - gutter));
      // Prefer the surface's real rendered height over the estimate; on the
      // very first pass after open it may still reflect the stale maxHeight,
      // the layout effect below re-anchors once the clamped height applies.
      const surface = menuRef.current;
      const actualHeight = surface ? surface.getBoundingClientRect().height : 0;
      const height = actualHeight > 0 ? actualHeight : maxHeight;
      const top = opensUpward
        ? Math.max(gutter, rect.top - height)
        : Math.min(rect.bottom + 4, window.innerHeight - height - gutter);

      setMenuPosition((pos) => {
        const changed =
          pos.top !== top ||
          pos.left !== left ||
          pos.minWidth !== width ||
          pos.maxHeight !== maxHeight ||
          pos.opensUpward !== opensUpward;
        return changed ? { top, left, minWidth: width, maxHeight, opensUpward } : pos;
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [align, open, options.length]);

  // The first pass above only estimates the surface height (maxHeight);
  // the real surface is often shorter (few options, no footer). Once the
  // actual height is known, re-anchor the surface to the trigger — otherwise
  // an upward-flipped menu floats with a gap above the trigger (it would sit
  // at rect.top - maxHeight instead of rect.top - actualHeight).
  useLayoutEffect(() => {
    if (!open) return;
    const surface = menuRef.current;
    const trigger = triggerRef.current;
    if (!surface || !trigger) return;
    const actualHeight = surface.getBoundingClientRect().height;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    let top = menuPosition.opensUpward
      ? Math.max(gutter, rect.top - actualHeight)
      : Math.min(rect.bottom + 4, window.innerHeight - actualHeight - gutter);
    // Footer (or its expandable content) can grow the surface beyond the
    // estimate; clamp it back inside the viewport.
    const overflow = top + actualHeight - (window.innerHeight - gutter);
    if (overflow > 0) top = Math.max(gutter, top - overflow);
    if (top !== menuPosition.top) {
      setMenuPosition((pos) => ({ ...pos, top }));
    }
  }, [open, footer, menuPosition]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
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

  return (
    <div
      ref={ref}
      className={`interface-density-control relative min-w-0 ${className}`}
      style={maxWidth ? { maxWidth } : undefined}
    >
      <button
        type="button"
        className={`interface-density-control flex h-8 w-full items-center gap-1 rounded-md px-2 text-xs outline-none transition-colors ${
          ghost
            ? "text-muted hover:bg-surface-overlay/60 hover:text-foreground"
            : "border border-border bg-surface text-foreground hover:bg-surface-overlay/60 focus-visible:border-focus"
        } ${triggerClassName} disabled:cursor-default disabled:opacity-40`}
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel ?? selected?.label ?? ""}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="theme-floating-surface fixed z-[100] max-w-[calc(100vw-16px)] rounded-md border border-border bg-surface-raised shadow-lg"
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
              minWidth: menuPosition.minWidth,
            }}
          >
            <div
              role="listbox"
              aria-label={ariaLabel}
              className={`w-full overflow-y-auto overscroll-contain rounded-t-md py-1 ${
                footer ? "" : "rounded-b-md"
              }`}
              style={{ maxHeight: menuPosition.maxHeight }}
            >
              {options.map((option) => {
              const isSelected = option.value === value;
              const header = groupHeaders.get(option.value);
              return (
                <Fragment key={option.value}>
                  {header !== undefined && (
                    <div
                      role="presentation"
                      className="flex h-7 items-center px-2.5 pt-1 text-xs font-medium text-foreground"
                    >
                      {header}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-xs transition-colors hover:bg-surface-overlay ${
                      isSelected ? "font-medium text-foreground" : "text-muted"
                    }`}
                    onClick={() => {
                      setOpen(false);
                      onChange(option.value);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected && (
                      <span className="flex shrink-0 items-center justify-center">
                        <Check size={16} strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                </Fragment>
              );
            })}
            </div>
            {footer && <div className="relative">{footer}</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}
