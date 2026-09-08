import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve as pathResolve } from "node:path";

const DIR_MODE = 0o700;

export const PIABYSS_MODEL_BACKUP_PATTERN = /^models-(\d+)-[0-9a-f]{8}\.bak$/u;

export function workspaceStorageKey(cwd: string): string {
  const resolvedCwd = pathResolve(cwd);
  return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function piabyssDataDir(agentDir: string): string {
  return join(pathResolve(agentDir), "piabyss");
}

export function migrationBackupRoot(agentDir: string, migrationId: string): string {
  return join(piabyssDataDir(agentDir), "migration-backups", migrationId);
}

/**
 * Quarantine for legacy data that collides with already-adopted PiAbyss data.
 * The destination copy always stays authoritative; the source copy is moved
 * here so nothing is silently lost, and startup never fails on a conflict.
 */
export function migrationConflictsRoot(agentDir: string, migrationId: string): string {
  return join(piabyssDataDir(agentDir), "migration-conflicts", migrationId);
}

export function providerJournalRoot(agentDir: string): string {
  return join(piabyssDataDir(agentDir), "provider-journal");
}

export function modelBackupDir(agentDir: string): string {
  return join(piabyssDataDir(agentDir), "model-backups");
}

function sessionArchiveRoot(agentDir: string): string {
  return join(piabyssDataDir(agentDir), "session-archive");
}

export function attachmentRoot(agentDir: string): string {
  return join(piabyssDataDir(agentDir), "attachments");
}

export function sessionArchiveDir(agentDir: string, cwd: string): string {
  return join(sessionArchiveRoot(agentDir), workspaceStorageKey(cwd));
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null | undefined)?.code;
}

async function pathKind(path: string): Promise<"directory" | "other" | null> {
  try {
    return (await lstat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await chmod(path, DIR_MODE);
}

type MoveCollisionContext = {
  /** Quarantine root for this migration run. */
  root: string;
  /** Legacy tree root, used to compute each source's relative path. */
  relativeBase: string;
  /** Per-run uniqueness stamp so parallel conflicts never collide. */
  stamp: string;
  /** Quarantine destinations created during the run. */
  moved: string[];
};

async function moveLegacyTree(
  source: string,
  target: string,
  collisions?: MoveCollisionContext,
): Promise<void> {
  const sourceKind = await pathKind(source);
  if (sourceKind === null) return;

  const targetKind = await pathKind(target);
  if (targetKind === null) {
    await ensurePrivateDirectory(dirname(target));
    try {
      await rename(source, target);
      if (sourceKind === "directory" && process.platform !== "win32") {
        await chmod(target, DIR_MODE);
      }
      return;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST" && errnoCode(error) !== "ENOTEMPTY") throw error;
      // Another partially-completed migration populated the target. Merge it
      // under the same collision rules instead of overwriting either side.
    }
  }

  const currentTargetKind = await pathKind(target);
  if (sourceKind !== "directory" || currentTargetKind !== "directory") {
    // Both sides exist and at least one is a file. A byte-identical file means
    // the data was already adopted — drop the redundant source copy. Anything
    // else (different content, or a directory/file mismatch) moves the SOURCE
    // into quarantine: the destination stays authoritative, nothing is lost,
    // and a stray legacy tree can never fail Host startup again.
    if (sourceKind === "other" && currentTargetKind === "other") {
      const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
      if (sourceBytes.equals(targetBytes)) {
        await rm(source);
        return;
      }
    }
    if (collisions) {
      const destination = join(
        collisions.root,
        collisions.stamp,
        relative(collisions.relativeBase, source),
      );
      await ensurePrivateDirectory(dirname(destination));
      await rename(source, destination);
      collisions.moved.push(destination);
      return;
    }
    throw new Error(`Conflicting PiAbyss data at ${source} and ${target}`);
  }

  await ensurePrivateDirectory(target);
  const entries = await readdir(source);
  for (const entry of entries) {
    await moveLegacyTree(join(source, entry), join(target, entry), collisions);
  }
  // Tolerant: a concurrent migration or an unreadable entry may leave residue;
  // the next startup re-merges it (the operation stays restartable).
  await removeEmptyDirectory(source);
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errnoCode(error) ?? "")) throw error;
  }
}

export type LegacyMigrationResult = {
  /** Quarantine destinations for source copies that collided with adopted data. */
  quarantined: string[];
};

/**
 * Adopt data written by older PiAbyss versions. Every source and destination is
 * inside one agent directory, so successful renames stay on the same volume.
 * The operation is restartable and never overwrites conflicting recovery data:
 * a colliding source copy is quarantined instead of failing startup.
 */
export async function migrateLegacyPiAbyssData(
  agentDir: string,
  migrationId: string,
): Promise<LegacyMigrationResult> {
  const resolvedAgentDir = pathResolve(agentDir);
  await ensurePrivateDirectory(piabyssDataDir(resolvedAgentDir));
  const collisions: MoveCollisionContext = {
    root: migrationConflictsRoot(resolvedAgentDir, migrationId),
    relativeBase: resolvedAgentDir,
    stamp: `run-${Date.now().toString(36)}`,
    moved: [],
  };

  // Adopt the legacy `pideck` namespace from older versions. When the Rust
  // shell already renamed it, this is a no-op; when both exist (partial
  // migration), moveLegacyTree merges under its collision rules.
  await moveLegacyTree(
    join(resolvedAgentDir, "pideck"),
    piabyssDataDir(resolvedAgentDir),
    collisions,
  );

  await moveLegacyTree(
    join(resolvedAgentDir, "backups", migrationId),
    migrationBackupRoot(resolvedAgentDir, migrationId),
    collisions,
  );
  await removeEmptyDirectory(join(resolvedAgentDir, "backups"));

  await moveLegacyTree(
    join(resolvedAgentDir, "provider-journal"),
    providerJournalRoot(resolvedAgentDir),
    collisions,
  );

  const backups = await readdir(resolvedAgentDir, { withFileTypes: true });
  const targetModelBackupDir = modelBackupDir(resolvedAgentDir);
  await ensurePrivateDirectory(targetModelBackupDir);
  for (const entry of backups) {
    if (!entry.isFile() || !PIABYSS_MODEL_BACKUP_PATTERN.test(entry.name)) continue;
    await moveLegacyTree(
      join(resolvedAgentDir, entry.name),
      join(targetModelBackupDir, entry.name),
      collisions,
    );
  }

  const sessionsRoot = join(resolvedAgentDir, "sessions");
  const workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch((error) => {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  });
  for (const entry of workspaceDirs) {
    if (!entry.isDirectory()) continue;
    await moveLegacyTree(
      join(sessionsRoot, entry.name, ".archive"),
      join(sessionArchiveRoot(resolvedAgentDir), entry.name),
      collisions,
    );
  }
  return { quarantined: collisions.moved };
}
