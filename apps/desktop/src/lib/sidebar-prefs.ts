/** Sidebar collapse preferences — localStorage-backed, safe in non-DOM tests. */
export function sidebarPref(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Same storage as `sidebarPref`, but for switches whose **default is not
 * "off"**: an unwritten key yields `fallback` instead of `false`. Used by the
 * pixie side panel's groups, where 「待办」 starts expanded while 「周期计划」/
 * 「委派任务」 start collapsed.
 */
export function sidebarPrefDefault(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
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
