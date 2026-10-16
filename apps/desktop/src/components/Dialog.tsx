import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, PackageOpen, X, type LucideIcon } from "lucide-react";
import { useT } from "../lib/i18n/use-t";

const buttonBase =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-40";
export const secondaryButton = `${buttonBase} theme-secondary-control border border-border hover:bg-surface-overlay`;
export const primaryButton = `${buttonBase} theme-primary-control bg-accent text-accent-foreground hover:bg-accent-hover`;

export type DialogTone = "default" | "warning" | "danger";

const CONFIRM_BUTTON: Record<DialogTone, string> = {
  default: primaryButton,
  warning: `${buttonBase} bg-warning text-black hover:bg-warning/80`,
  danger: `${buttonBase} bg-danger text-white hover:bg-danger/85`,
};

const ICON_CHIP: Record<DialogTone, string> = {
  default: "bg-accent/15 text-accent",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

export function Dialog({
  title,
  children,
  confirmLabel,
  tone = "default",
  icon: Icon = PackageOpen,
  showCancel = true,
  showCloseIcon = false,
  hideActions = false,
  /** Extra content (e.g. small mode toggles) rendered in the header row,
   *  between the title and the close icon. */
  headerExtra,
  footerExtra,
  maxWidthClass = "max-w-lg",
  maxHeightClass = "max-h-[min(680px,90vh)]",
  fillBody = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: DialogTone;
  icon?: LucideIcon;
  showCancel?: boolean;
  /** Render a close (×) button in the top-right corner instead of the footer actions. */
  showCloseIcon?: boolean;
  /** Hide the footer action buttons entirely (e.g. informational help dialogs). */
  hideActions?: boolean;
  /** Header-right slot: between the title and the close icon. */
  headerExtra?: ReactNode;
  /** Footer-left slot (e.g. destructive secondary actions); rendered before
   *  the right-aligned cancel/confirm group. */
  footerExtra?: ReactNode;
  /** Override the dialog's max-width Tailwind class (default 512px / max-w-lg). */
  maxWidthClass?: string;
  /** Override the dialog's max-height Tailwind class. */
  maxHeightClass?: string;
  /**
   * Let the body own the scrolling: the panel stops being a scroll container and
   * the body becomes a `flex-1 min-h-0` column, so the header (and any footer)
   * stays pinned while a tall editor inside it scrolls on its own.
   */
  fillBody?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline handlers; route through a ref so the effect stays
  // mount-stable and parent re-renders cannot re-run the initial focus().
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const dialog = ref.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // A layer above this dialog (e.g. an extension modal) already acted on
      // the key; do not double-fire.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        // Consume the event so outer Escape handlers (e.g. the Settings
        // overlay close) never see it: closing this dialog is the whole action.
        event.preventDefault();
        event.stopPropagation();
        return onCancelRef.current();
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return event.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Portalled to document.body: an ancestor with backdrop-filter or a
  // transform (e.g. the frosted sidebar) would otherwise turn this `fixed`
  // overlay into a containing block and squeeze it into that ancestor.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        className={`theme-floating-surface w-full rounded-xl border border-border bg-surface-raised p-5 shadow-2xl ${
          fillBody ? "flex min-h-0 flex-col overflow-hidden" : "overflow-auto"
        } ${maxWidthClass} ${maxHeightClass}`}
      >
        {/* Header: icon + title share one row; close icon sits at the end. */}
        <div className="flex shrink-0 items-center gap-3">
          <div className={`rounded-md p-1.5 ${ICON_CHIP[tone]}`}>
            {tone === "default" ? <Icon size={18} /> : <AlertTriangle size={18} />}
          </div>
          <h2 id="app-dialog-title" className="min-w-0 flex-1 truncate text-base font-semibold">
            {title}
          </h2>
          {headerExtra}
          {showCloseIcon && (
            <button
              type="button"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
              title={t("commonClose")}
              aria-label={t("commonClose")}
              onClick={onCancel}
            >
              <X size={16} />
            </button>
          )}
        </div>
        {/* Body: full width below the header row. */}
        <div
          className={`mt-3 text-sm text-muted ${fillBody ? "flex min-h-0 flex-1 flex-col" : ""}`}
        >
          {children}
        </div>
        {!hideActions && (
          <div className="mt-5 flex shrink-0 items-center justify-between gap-2">
            <div className="min-w-0">{footerExtra}</div>
            <div className="flex shrink-0 justify-end gap-2">
              {showCancel && (
                <button type="button" className={secondaryButton} onClick={onCancel}>
                  {t("commonCancel")}
                </button>
              )}
              <button type="button" className={CONFIRM_BUTTON[tone]} onClick={onConfirm}>
                {confirmLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
