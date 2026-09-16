let cached: string | null = null;

/** Build-time injected app version (from src-tauri/tauri.conf.json via Vite `define`). */
const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "0.0.0";

/** PiAbyss's own version from the Tauri app config (falls back in browser mock). */
export async function getAppVersion(): Promise<string> {
  if (cached) return cached;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    cached = await getVersion();
  } catch {
    cached = APP_VERSION;
  }
  return cached;
}

/** Default User-Agent sent for newly created model providers; follows the app version. */
export const DEFAULT_USER_AGENT = `PiAbyss/${APP_VERSION}`;
