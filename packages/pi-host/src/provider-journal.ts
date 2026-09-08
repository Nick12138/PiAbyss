/**
 * Crash-durable journal for provider mutations.
 *
 * A provider change writes two files that no single rename can cover together:
 * `models.json` (provider configuration) and `auth.json` (its credential). If
 * the Host dies between them, the in-memory rollback in provider-controller
 * never runs and the user is left with a provider whose configuration and
 * credential disagree.
 *
 * The journal makes that state detectable. Before committing anything, the
 * pre-mutation bytes of both files are copied to disk alongside a journal
 * record. The record is removed only after the whole mutation, including the
 * local refresh and reconciliation, has succeeded. So a journal found at
 * startup means exactly one thing: a mutation did not finish.
 *
 * Recovery restores both files from those copies. If it cannot, the journal is
 * kept and `modelConfigHealth` reports `degraded`, because at that point the
 * Host genuinely does not know whether the configuration is coherent.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderMutationStage } from "@piabyss/protocol";
import { logger } from "./logger.js";
import type { FileCredentialStore } from "./credential-store.js";
import { providerJournalRoot as journalRoot } from "./piabyss-data.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const JOURNAL_FILE = "journal.json";

export type ProviderJournalRecord = {
  schemaVersion: 1;
  journalId: string;
  startedAt: string;
  operation: string;
  providerId: string;
  stage: ProviderMutationStage;
  modelsPath: string;
  /** `null` when models.json did not exist before the mutation. */
  modelsBackup: string | null;
};

export type JournalRecovery = {
  journalId: string;
  stage: ProviderMutationStage;
  restored: boolean;
  message: string;
};

function entryDir(agentDir: string, journalId: string): string {
  return join(journalRoot(agentDir), journalId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null | undefined)?.code;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeRecord(directory: string, record: ProviderJournalRecord): Promise<void> {
  const path = join(directory, JOURNAL_FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(temp, JSON.stringify(record, null, 2) + "\n");
    await rename(temp, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function readRecord(directory: string): Promise<ProviderJournalRecord | null> {
  const raw = await readFile(join(directory, JOURNAL_FILE), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as ProviderJournalRecord;
    if (parsed.schemaVersion !== 1 || typeof parsed.journalId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * An open journal entry. Exactly one can exist at a time because every provider
 * mutation holds `serviceGraphLock`.
 */
export class ProviderMutationJournal {
  private constructor(
    private readonly agentDir: string,
    private readonly directory: string,
    private readonly record: ProviderJournalRecord,
    private readonly credentialStore: FileCredentialStore,
  ) {}

  get journalId(): string {
    return this.record.journalId;
  }

  /**
   * Capture pre-mutation state. Call after validating the candidate config and
   * before writing anything the user can observe.
   */
  static async begin(options: {
    agentDir: string;
    operation: string;
    providerId: string;
    modelsPath: string;
    /** Exact pre-mutation models.json bytes, or null when it did not exist. */
    modelsBytes: string | null;
    credentialStore: FileCredentialStore;
  }): Promise<ProviderMutationJournal> {
    const journalId = randomUUID();
    const directory = entryDir(options.agentDir, journalId);
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
    await syncDirectory(options.agentDir);
    await syncDirectory(journalRoot(options.agentDir));

    let modelsBackup: string | null = null;
    if (options.modelsBytes !== null) {
      modelsBackup = join(directory, "models.json");
      await writeDurableFile(modelsBackup, options.modelsBytes);
    }

    // The credential snapshot is whole-file, so it restores every provider the
    // mutation might touch, not just the named one.
    const snapshot = await options.credentialStore.snapshot();
    const authBackup = join(directory, "auth.json");
    if (snapshot.content === null) {
      await writeDurableFile(join(directory, "auth.absent"), "");
    } else {
      await writeDurableFile(authBackup, snapshot.content);
    }
    await syncDirectory(directory);

    const record: ProviderJournalRecord = {
      schemaVersion: 1,
      journalId,
      startedAt: new Date().toISOString(),
      operation: options.operation,
      providerId: options.providerId,
      stage: "prepared",
      modelsPath: options.modelsPath,
      modelsBackup,
    };
    await writeRecord(directory, record);
    return new ProviderMutationJournal(
      options.agentDir,
      directory,
      record,
      options.credentialStore,
    );
  }

  /** Both durable writes landed; only reconciliation remains. */
  async markCommitted(): Promise<void> {
    this.record.stage = "committed";
    await writeRecord(this.directory, this.record);
  }

  /** The mutation fully succeeded. Removing the entry is the commit marker. */
  async finish(): Promise<void> {
    try {
      await rm(this.directory, { recursive: true, force: true });
      await syncDirectory(journalRoot(this.agentDir));
    } catch (error) {
      logger.warn("Could not clear provider journal entry", {
        journalId: this.record.journalId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Restore both files from the captured copies. Keeps the entry when it
   * cannot, so startup reports a degraded configuration instead of silently
   * continuing.
   */
  async rollback(): Promise<JournalRecovery> {
    const outcome = await restoreFromEntry(
      this.agentDir,
      this.directory,
      this.record,
      this.credentialStore,
    );
    if (outcome.restored) await this.finish();
    return outcome;
  }
}

async function restoreFromEntry(
  agentDir: string,
  directory: string,
  record: ProviderJournalRecord,
  credentialStore: FileCredentialStore,
): Promise<JournalRecovery> {
  const failures: string[] = [];
  let modelsPlan: { kind: "restore"; content: string } | { kind: "remove" } | null = null;
  let authContent: string | null = null;
  let authReady = false;

  try {
    modelsPlan =
      record.modelsBackup === null
        ? { kind: "remove" }
        : { kind: "restore", content: await readFile(join(directory, "models.json"), "utf8") };
  } catch (error) {
    failures.push(`models.json backup: ${errorMessage(error)}`);
  }

  try {
    authContent = await readCredentialBackup(directory);
    authReady = true;
  } catch (error) {
    failures.push(`auth.json credential backup: ${errorMessage(error)}`);
  }

  // An incomplete journal is not authority to mutate either live file. Keep
  // the entry so startup remains degraded until recovery can be resolved.
  if (modelsPlan && authReady) {
    try {
      if (modelsPlan.kind === "restore") {
        const bytes = modelsPlan.content;
        const temp = `${record.modelsPath}.${randomUUID()}.restore`;
        await writeFile(temp, bytes, { encoding: "utf8", mode: FILE_MODE });
        await rename(temp, record.modelsPath);
      } else {
        // models.json did not exist before the mutation.
        await unlink(record.modelsPath).catch((error: unknown) => {
          if (errnoCode(error) !== "ENOENT") throw error;
        });
      }
    } catch (error) {
      failures.push(`models.json: ${errorMessage(error)}`);
    }

    try {
      await credentialStore.restore({
        path: credentialStorePath(agentDir),
        content: authContent,
      });
    } catch (error) {
      failures.push(`auth.json: ${errorMessage(error)}`);
    }
  }

  return {
    journalId: record.journalId,
    stage: record.stage,
    restored: failures.length === 0,
    message:
      failures.length === 0
        ? `Rolled back interrupted ${record.operation} of provider ${record.providerId}`
        : `Could not fully roll back ${record.operation} of provider ${record.providerId}: ${failures.join("; ")}`,
  };
}

type OptionalBackup = { present: false } | { present: true; content: string };

async function readOptionalBackup(path: string): Promise<OptionalBackup> {
  try {
    return { present: true, content: await readFile(path, "utf8") };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { present: false };
    throw error;
  }
}

async function readCredentialBackup(directory: string): Promise<string | null> {
  const [backup, absent] = await Promise.all([
    readOptionalBackup(join(directory, "auth.json")),
    readOptionalBackup(join(directory, "auth.absent")),
  ]);

  if (backup.present && absent.present) {
    throw new Error("auth.json and auth.absent both exist");
  }
  if (!backup.present && !absent.present) {
    throw new Error("auth.json and auth.absent are both missing");
  }
  if (absent.present) {
    if (absent.content.length !== 0) {
      throw new Error("auth.absent is not an empty marker");
    }
    return null;
  }
  if (!backup.present) {
    throw new Error("auth.json backup state is invalid");
  }
  return backup.content;
}

function credentialStorePath(agentDir: string): string {
  return join(agentDir, "auth.json");
}

/**
 * Resolve any journal left by a previous run. Call during startup, before the
 * first status is published.
 *
 * Returns `null` when nothing was pending. Otherwise returns the outcome; a
 * `restored: false` result must surface as degraded configuration health.
 */
export async function recoverProviderJournals(
  agentDir: string,
  credentialStore: FileCredentialStore,
): Promise<JournalRecovery | null> {
  const root = journalRoot(agentDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) return null;

  let unresolved: JournalRecovery | null = null;
  for (const name of directories) {
    const directory = join(root, name);
    const record = await readRecord(directory);
    if (!record) {
      // Nothing actionable: a partial entry without a record cannot be replayed.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const outcome = await restoreFromEntry(agentDir, directory, record, credentialStore);
    if (outcome.restored) {
      logger.warn("Recovered an interrupted provider mutation", {
        journalId: outcome.journalId,
        stage: outcome.stage,
      });
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    } else {
      logger.error("Provider mutation recovery incomplete", {
        journalId: outcome.journalId,
        stage: outcome.stage,
        message: outcome.message,
      });
      unresolved = outcome;
    }
  }
  return unresolved;
}
