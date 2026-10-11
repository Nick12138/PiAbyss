import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Portal target for the active section's action buttons. AppTopBar owns the
 *  real slot (the right side of its center segment); SettingsPage (and other
 *  section components) render into it via <SettingsTopBarActions>. */
export const SettingsTopBarActionsContext = createContext<HTMLElement | null>(null);

/** Render section-specific action buttons into the app-level top bar's actions
 *  slot. When no portal target is present (a section rendered in isolation,
 *  e.g. in a focused test), it falls back to an inline header so the title,
 *  subtitle and actions remain visible together. */
export function SettingsTopBarActions({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  const target = useContext(SettingsTopBarActionsContext);
  if (!target) {
    return (
      <header
        className="flex min-h-16 shrink-0 items-start gap-3 px-6 pb-2 pt-3"
        data-settings-has-actions={children ? "" : undefined}
        data-settings-section-header
        data-tauri-drag-region
      >
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
        </div>
        {children && (
          <div
            className="ml-auto flex shrink-0 items-center gap-2 pr-[50px]"
            data-settings-header-actions
          >
            {children}
          </div>
        )}
      </header>
    );
  }
  return createPortal(children, target);
}
