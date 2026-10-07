import type {
  Window as TauriWindow,
  UserAttentionType as UserAttentionTypeValue,
} from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";

type WindowModule = {
  getCurrentWindow: () => TauriWindow;
  UserAttentionType: typeof UserAttentionTypeValue;
};

/**
 * Taskbar/dock attention request for background notifications.
 *
 * Windows: a custom `taskbar_flash` Rust command calling `FlashWindowEx`
 * directly (see `src-tauri/src/taskbar_flash.rs`). The stock
 * `requestUserAttention` path is broken for borderless windows whose
 * minimize goes through `ShowWindow(SW_MINIMIZE)` instead of
 * `WM_SYSCOMMAND`: tao's internal MINIMIZED flag never flips and its
 * "skip when active" guard swallows the request. `FLASHW_ALL |
 * FLASHW_TIMERNOFG` flashes the caption and taskbar button until the
 * window comes to the foreground.
 *
 * Other platforms: Tauri's `requestUserAttention(Critical)` — macOS Dock
 * bounce (one second, coalesced by the OS). The in-app toast flow stays
 * untouched; this is purely the OS-level hint.
 */

let windowModule: WindowModule | null = null;

async function resolveWindowModule(): Promise<WindowModule | null> {
  if (windowModule) return windowModule;
  try {
    return (windowModule ??= await import("@tauri-apps/api/window"));
  } catch {
    // Non-Tauri environment (unit tests without the mock, web preview):
    // nothing to flash.
    return null;
  }
}

const IS_WINDOWS = () => /^win/i.test(navigator.platform);

/**
 * Flash the taskbar button while the window is unfocused. Safe to call
 * repeatedly: FlashWindowEx replaces the previous flash request, and macOS
 * bounce notifications are coalesced by the OS.
 */
export async function requestTaskbarAttention(): Promise<void> {
  try {
    if (IS_WINDOWS() && isTauri()) {
      // Custom command: FlashWindowEx without tao's minimize guard.
      await (
        await import("@tauri-apps/api/core")
      ).invoke("taskbar_flash", {
        options: { stop: false },
      });
      return;
    }
    const mod = await resolveWindowModule();
    if (!mod) return;
    await mod.getCurrentWindow().requestUserAttention(mod.UserAttentionType.Critical);
  } catch (error) {
    // Attention requests are best-effort; never let one break notification
    // delivery. Reported on the [notify] debug trail.
    console.debug("[notify] taskbar attention request failed", error);
  }
}

/** Cancels a pending flash (no-op when the window already has focus). */
export async function cancelTaskbarAttention(): Promise<void> {
  try {
    if (IS_WINDOWS() && isTauri()) {
      await (
        await import("@tauri-apps/api/core")
      ).invoke("taskbar_flash", {
        options: { stop: true },
      });
      return;
    }
    const mod = await resolveWindowModule();
    if (!mod) return;
    await mod.getCurrentWindow().requestUserAttention(null);
  } catch (error) {
    console.debug("[notify] taskbar attention cancel failed", error);
  }
}
