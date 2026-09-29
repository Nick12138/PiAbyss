/**
 * Pixie retention metrics — the V1 go/no-go counters from the design doc:
 * daily interactions (user messages to the pixie) and daily dispatches.
 * Stored as a small JSON file under the PiAbyss data root; the last 30 days
 * are kept, anything older is pruned on write. No analytics leaves the
 * machine — the settings/about surface reads the same file via pixie.usage.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PixieUsageStats } from "@piabyss/protocol";
import { pixieDir } from "./pixie-agent-runner.js";

const USAGE_FILE = "usage.json";
const KEEP_DAYS = 30;

type UsageFile = {
  version: 1;
  days: Record<string, { interactions: number; dispatches: number }>;
};

const emptyFile = (): UsageFile => ({ version: 1, days: {} });

/** Local-date key (YYYY-MM-DD) — retention judgements are per user-day. */
export function localDayKey(at: number = Date.now()): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function filePath(agentDir: string): string {
  return join(pixieDir(agentDir), USAGE_FILE);
}

function load(agentDir: string): UsageFile {
  const path = filePath(agentDir);
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as UsageFile).version !== 1 ||
      typeof (parsed as UsageFile).days !== "object" ||
      (parsed as UsageFile).days === null
    ) {
      return emptyFile();
    }
    const days: UsageFile["days"] = {};
    for (const [key, value] of Object.entries((parsed as UsageFile).days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const interactions = Number((value as { interactions?: unknown })?.interactions);
      const dispatches = Number((value as { dispatches?: unknown })?.dispatches);
      if (!Number.isSafeInteger(interactions) || !Number.isSafeInteger(dispatches)) continue;
      days[key] = { interactions, dispatches };
    }
    return { version: 1, days };
  } catch {
    return emptyFile();
  }
}

function save(agentDir: string, file: UsageFile): void {
  // Prune anything older than the retention window.
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const pruned: UsageFile = { version: 1, days: {} };
  for (const [key, value] of Object.entries(file.days)) {
    const at = new Date(`${key}T23:59:59`).getTime();
    if (Number.isFinite(at) && at >= cutoff) pruned.days[key] = value;
  }
  try {
    writeFileSync(filePath(agentDir), JSON.stringify(pruned, null, 2), "utf8");
  } catch {
    /* counters are best-effort; never break the pixie on IO failure */
  }
}

/** Count one user interaction with the pixie (message send or continue). */
export function recordPixieInteraction(agentDir: string): void {
  const file = load(agentDir);
  const key = localDayKey();
  const day = file.days[key] ?? { interactions: 0, dispatches: 0 };
  day.interactions += 1;
  file.days[key] = day;
  save(agentDir, file);
}

/** Count one delegation accepted by the pixie. */
export function recordPixieDispatch(agentDir: string): void {
  const file = load(agentDir);
  const key = localDayKey();
  const day = file.days[key] ?? { interactions: 0, dispatches: 0 };
  day.dispatches += 1;
  file.days[key] = day;
  save(agentDir, file);
}

export function readPixieUsage(agentDir: string): PixieUsageStats {
  return { days: { ...load(agentDir).days } };
}
