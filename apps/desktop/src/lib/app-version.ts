let cached: string | null = null;

/** PiAbyss's own version from the Tauri app config (falls back in browser mock). */
export async function getAppVersion(): Promise<string> {
  if (cached) return cached;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    cached = await getVersion();
  } catch {
    cached = "0.1.0";
  }
  return cached;
}
