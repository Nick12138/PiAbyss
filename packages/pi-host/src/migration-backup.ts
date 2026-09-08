/**
 * One-time user-data backup taken before the SDK 0.82.1 runtime first touches
 * a real agent directory.
 *
 * SDK 0.82.1 introduces `models-store.json`, an app-owned credential store, and
 * a different provider composition path. Any of those can rewrite files the
 * 0.80.7 runtime wrote, and a downgrade is only safe if the pre-migration bytes
 * still exist. So the backup must complete before the first
 * `ModelRuntime.create()` against the user's own `PI_CODING_AGENT_DIR`.
 *
 * The manifest records sizes and SHA-256 digests, never file contents, so it
 * can be attached to a bug report. The copies themselves are secret-bearing and
 * inherit 0600/0700.
 *
 * Session bodies are deliberately not copied — only each session's header line
 * plus a digest of the whole file. That matches the rollback procedure, which
 * restores session metadata rather than conversation history, and keeps the
 * backup bounded for users with large histories.
 *
 * Completion is not declared until every dependent path has been exercised at
 * least once, possibly across several runs: runtime creation, a local refresh,
 * opening a pre-existing session, a provider snapshot, and a clean shutdown.
 * Until then the backup is retained and reused.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { logger } from "./logger.js";
import { migrationBackupRoot } from "./piabyss-data.js";

export const MIGRATION_ID = "piabyss-sdk-0.80.7-to-0.82.1";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Cwd-independent files the 0.82.1 runtime may rewrite. */
const TRACKED_FILES = ["auth.json", "models.json", "models-store.json", "settings.json"] as const;

export type MigrationMilestone =
  | "runtimeCreate"
  | "localRefresh"
  | "sessionOpened"
  | "providerSnapshot"
  | "cleanShutdown"
  | "serverStart";

const REQUIRED_MILESTONES: readonly MigrationMilestone[] = [
  "runtimeCreate",
  "localRefresh",
  "sessionOpened",
  "providerSnapshot",
  "cleanShutdown",
];

type FileRecord = {
  path: string;
  present: boolean;
  bytes?: number;
  sha256?: string;
};

type SessionRecord = {
  path: string;
  bytes: number;
  sha256: string;
};

export type MigrationManifest = {
  schemaVersion: 1;
  migrationId: string;
  createdAt: string;
  agentDir: string;
  /** Vacuously satisfied when the directory held no sessions to migrate. */
  sessionCount: number;
  files: FileRecord[];
  sessions: SessionRecord[];
};

type MigrationState = {
  schemaVersion: 1;
  migrationId: string;
  milestones: MigrationMilestone[];
  completedAt?: string;
};

function backupRoot(agentDir: string): string {
  return migrationBackupRoot(agentDir, MIGRATION_ID);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function readFirstLine(path: string): Promise<string | null> {
  const handle = await readFile(path, "utf8").catch(() => null);
  if (handle === null) return null;
  const newline = handle.indexOf("\n");
  return newline < 0 ? handle : handle.slice(0, newline);
}

async function listSessionFiles(sessionsDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  };
  await walk(sessionsDir);
  return found.sort();
}

/**
 * Handle for a backup that exists but has not yet proven the migration safe.
 * Milestones persist across runs.
 */
export class MigrationBackup {
  private constructor(
    private readonly statePath: string,
    private readonly state: MigrationState,
    readonly directory: string,
    readonly manifest: MigrationManifest,
  ) {}

  /** @internal */
  static attach(
    statePath: string,
    state: MigrationState,
    directory: string,
    manifest: MigrationManifest,
  ): MigrationBackup {
    return new MigrationBackup(statePath, state, directory, manifest);
  }

  get milestones(): readonly MigrationMilestone[] {
    return this.state.milestones;
  }

  /**
   * Record that a dependent path succeeded. Failures here must never break the
   * Host: a lost milestone only means the backup is retained longer.
   */
  async recordMilestone(milestone: MigrationMilestone): Promise<void> {
    if (this.state.milestones.includes(milestone)) return;
    this.state.milestones.push(milestone);
    try {
      await this.persist();
    } catch (error) {
      logger.warn("Could not persist migration milestone", {
        milestone,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.satisfied()) await this.complete();
  }

  private satisfied(): boolean {
    return REQUIRED_MILESTONES.every((milestone) => {
      // Nothing to prove when the directory held no sessions to migrate.
      if (milestone === "sessionOpened" && this.manifest.sessionCount === 0) return true;
      return this.state.milestones.includes(milestone);
    });
  }

  private async complete(): Promise<void> {
    this.state.completedAt = new Date().toISOString();
    try {
      await this.persist();
      logger.info("Pi SDK migration marked complete", {
        migrationId: MIGRATION_ID,
        backup: this.directory,
      });
    } catch (error) {
      logger.warn("Could not write migration completion marker", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persist(): Promise<void> {
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2) + "\n", {
      encoding: "utf8",
      mode: FILE_MODE,
    });
  }
}

async function readState(statePath: string): Promise<MigrationState | null> {
  const raw = await readFile(statePath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as MigrationState;
    if (parsed.migrationId !== MIGRATION_ID || !Array.isArray(parsed.milestones)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readManifest(directory: string): Promise<MigrationManifest | null> {
  const raw = await readFile(join(directory, "manifest.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as MigrationManifest;
    return parsed.migrationId === MIGRATION_ID ? parsed : null;
  } catch {
    return null;
  }
}

/** Most recent backup directory that has a readable manifest. */
async function findExistingBackup(
  root: string,
): Promise<{ directory: string; manifest: MigrationManifest } | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const directory = join(root, name);
    const manifest = await readManifest(directory);
    if (manifest) return { directory, manifest };
  }
  return null;
}

async function captureBackup(
  agentDir: string,
  timestamp: string,
): Promise<{
  directory: string;
  manifest: MigrationManifest;
}> {
  const directory = join(backupRoot(agentDir), timestamp);
  await mkdir(directory, { recursive: true, mode: DIR_MODE });

  const files: FileRecord[] = [];
  for (const name of TRACKED_FILES) {
    const source = join(agentDir, name);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) {
      files.push({ path: name, present: false });
      continue;
    }
    const target = join(directory, name);
    await copyFile(source, target);
    // copyFile inherits the source mode, so a world-readable auth.json would
    // produce a world-readable backup. Tighten unconditionally.
    await chmod(target, FILE_MODE).catch(() => undefined);
    files.push({
      path: name,
      present: true,
      bytes: info.size,
      sha256: await sha256File(source),
    });
  }

  const sessionsDir = join(agentDir, "sessions");
  const sessionFiles = await listSessionFiles(sessionsDir);
  const sessions: SessionRecord[] = [];
  const headerLines: string[] = [];
  for (const file of sessionFiles) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const relativePath = relative(agentDir, file).split("\\").join("/");
    sessions.push({
      path: relativePath,
      bytes: info.size,
      sha256: await sha256File(file),
    });
    const header = await readFirstLine(file);
    if (header) headerLines.push(JSON.stringify({ path: relativePath, header }));
  }
  if (headerLines.length > 0) {
    await writeFile(join(directory, "session-headers.jsonl"), headerLines.join("\n") + "\n", {
      encoding: "utf8",
      mode: FILE_MODE,
    });
  }

  const manifest: MigrationManifest = {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    createdAt: new Date().toISOString(),
    agentDir,
    sessionCount: sessions.length,
    files,
    sessions,
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  return { directory, manifest };
}

/**
 * Ensure the pre-migration backup exists. Call before the first
 * `ModelRuntime.create()` against a real agent directory.
 *
 * Returns `null` when the migration is already complete, so callers can skip
 * milestone bookkeeping. Rejects if the backup cannot be written: proceeding
 * would put user data beyond recovery, which is worse than refusing to start.
 */
export async function ensureMigrationBackup(
  agentDir: string,
  now: () => string = () => new Date().toISOString(),
): Promise<MigrationBackup | null> {
  const root = backupRoot(agentDir);
  const statePath = join(root, "state.json");

  const state = await readState(statePath);
  if (state?.completedAt) return null;

  await mkdir(root, { recursive: true, mode: DIR_MODE });

  const existing = await findExistingBackup(root);
  const captured = existing ?? (await captureBackup(agentDir, now().replace(/[:.]/g, "-")));

  if (!existing) {
    logger.info("Captured pre-migration backup", {
      migrationId: MIGRATION_ID,
      backup: captured.directory,
      sessionCount: captured.manifest.sessionCount,
      files: captured.manifest.files.filter((file) => file.present).map((file) => file.path),
    });
  }

  return MigrationBackup.attach(
    statePath,
    state ?? { schemaVersion: 1, migrationId: MIGRATION_ID, milestones: [] },
    captured.directory,
    captured.manifest,
  );
}
