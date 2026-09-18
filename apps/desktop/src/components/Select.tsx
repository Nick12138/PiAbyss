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
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({
    top: 0,
    left: 0,
    minWidth: 0,
    maxHeight: 240,
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
      const top = opensUpward
        ? Math.max(gutter, rect.top - maxHeight)
        : Math.min(rect.bottom + 4, window.innerHeight - maxHeight - gutter);

      setMenuPosition({ top, left, minWidth: width, maxHeight });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [align, open, options.length]);

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
        className={`interface-density-control flex h-8 w-full items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none transition-colors hover:bg-surface-overlay/60 focus-visible:border-focus disabled:cursor-default disabled:opacity-40 ${triggerClassName}`}
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ""}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className="theme-floating-surface fixed z-[100] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface-raised py-1 shadow-lg"
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
              minWidth: menuPosition.minWidth,
              maxHeight: menuPosition.maxHeight,
            }}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
