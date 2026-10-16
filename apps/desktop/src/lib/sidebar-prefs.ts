/** Sidebar collapse preferences — localStorage-backed, safe in non-DOM tests. */
export function sidebarPref(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setSidebarPref(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Read a JSON-serialized sidebar preference; falls back when unset/unavailable. */
export function sidebarJsonPref<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Persist a JSON-serializable sidebar preference. */
export function setSidebarJsonPref(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
