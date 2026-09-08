import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_ID } from "./migration-backup.js";
import {
  migrateLegacyPiAbyssData,
  migrationBackupRoot,
  migrationConflictsRoot,
  modelBackupDir,
  piabyssDataDir,
  providerJournalRoot,
  sessionArchiveDir,
} from "./piabyss-data.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(): { agentDir: string; cwd: string; safePath: string } {
  const root = mkdtempSync(join(tmpdir(), "piabyss-data-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = resolve(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return { agentDir, cwd, safePath };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("PiAbyss data paths", () => {
  it("keeps every PiAbyss-owned storage family under one agent namespace", () => {
    const { agentDir, cwd, safePath } = createFixture();

    expect(piabyssDataDir(agentDir)).toBe(join(agentDir, "piabyss"));
    expect(migrationBackupRoot(agentDir, MIGRATION_ID)).toBe(
      join(agentDir, "piabyss", "migration-backups", MIGRATION_ID),
    );
    expect(providerJournalRoot(agentDir)).toBe(join(agentDir, "piabyss", "provider-journal"));
    expect(modelBackupDir(agentDir)).toBe(join(agentDir, "piabyss", "model-backups"));
    expect(sessionArchiveDir(agentDir, cwd)).toBe(
      join(agentDir, "piabyss", "session-archive", safePath),
    );
  });
});

describe("migrateLegacyPiAbyssData", () => {
  it("adopts all four legacy storage families and is idempotent", async () => {
    const { agentDir, cwd, safePath } = createFixture();
    const legacyMigrationFile = join(
      agentDir,
      "backups",
      MIGRATION_ID,
      "snapshot",
      "manifest.json",
    );
    const legacyJournalFile = join(agentDir, "provider-journal", "journal-1", "journal.json");
    const legacyModelBackup = join(agentDir, "models-1001-00000001.bak");
    const unrelatedBackup = join(agentDir, "models-user-copy.bak");
    const legacyArchive = join(agentDir, "sessions", safePath, ".archive", "session.jsonl");
    write(legacyMigrationFile, "migration");
    write(legacyJournalFile, "journal");
    write(legacyModelBackup, "model backup");
    write(unrelatedBackup, "user backup");
    write(legacyArchive, "session");

    await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);
    await expect(migrateLegacyPiAbyssData(agentDir, MIGRATION_ID)).resolves.toEqual({
      quarantined: [],
    });

    expect(
      readFileSync(
        join(migrationBackupRoot(agentDir, MIGRATION_ID), "snapshot", "manifest.json"),
        "utf8",
      ),
    ).toBe("migration");
    expect(
      readFileSync(join(providerJournalRoot(agentDir), "journal-1", "journal.json"), "utf8"),
    ).toBe("journal");
    expect(readFileSync(join(modelBackupDir(agentDir), basename(legacyModelBackup)), "utf8")).toBe(
      "model backup",
    );
    expect(readFileSync(join(sessionArchiveDir(agentDir, cwd), "session.jsonl"), "utf8")).toBe(
      "session",
    );
    expect(existsSync(join(agentDir, "backups", MIGRATION_ID))).toBe(false);
    expect(existsSync(join(agentDir, "provider-journal"))).toBe(false);
    expect(existsSync(legacyModelBackup)).toBe(false);
    expect(existsSync(join(agentDir, "sessions", safePath, ".archive"))).toBe(false);
    expect(readFileSync(unrelatedBackup, "utf8")).toBe("user backup");
  });

  it("merges non-conflicting entries after a partially completed migration", async () => {
    const { agentDir } = createFixture();
    write(join(agentDir, "provider-journal", "legacy-entry", "journal.json"), "legacy");
    write(join(providerJournalRoot(agentDir), "new-entry", "journal.json"), "new");

    await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);

    expect(
      readFileSync(join(providerJournalRoot(agentDir), "legacy-entry", "journal.json"), "utf8"),
    ).toBe("legacy");
    expect(
      readFileSync(join(providerJournalRoot(agentDir), "new-entry", "journal.json"), "utf8"),
    ).toBe("new");
    expect(existsSync(join(agentDir, "provider-journal"))).toBe(false);
  });

  it("quarantines a conflicting file without overwriting either copy", async () => {
    const { agentDir } = createFixture();
    const legacy = join(agentDir, "provider-journal", "same-entry", "journal.json");
    const target = join(providerJournalRoot(agentDir), "same-entry", "journal.json");
    write(legacy, "legacy");
    write(target, "target");

    const result = await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);

    // Destination stays authoritative and untouched.
    expect(readFileSync(target, "utf8")).toBe("target");
    // The source copy survives in quarantine — nothing is silently lost.
    expect(result.quarantined).toHaveLength(1);
    expect(readFileSync(result.quarantined[0]!, "utf8")).toBe("legacy");
    expect(result.quarantined[0]!.startsWith(migrationConflictsRoot(agentDir, MIGRATION_ID))).toBe(
      true,
    );
    expect(existsSync(join(agentDir, "provider-journal"))).toBe(false);
  });

  it("drops a byte-identical conflicting file and keeps the adopted copy", async () => {
    const { agentDir } = createFixture();
    const legacy = join(agentDir, "provider-journal", "same-entry", "journal.json");
    const target = join(providerJournalRoot(agentDir), "same-entry", "journal.json");
    write(legacy, "same-bytes");
    write(target, "same-bytes");

    const result = await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);

    expect(result.quarantined).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe("same-bytes");
    expect(existsSync(join(agentDir, "provider-journal"))).toBe(false);
  });

  it("quarantines a directory/file collision instead of failing startup", async () => {
    const { agentDir } = createFixture();
    // Legacy side is a directory where the adopted side already has a file.
    const legacyDir = join(agentDir, "provider-journal", "clash");
    write(join(legacyDir, "inner.json"), "legacy-tree");
    write(join(providerJournalRoot(agentDir), "clash"), "adopted-file");

    const result = await migrateLegacyPiAbyssData(agentDir, MIGRATION_ID);

    expect(readFileSync(join(providerJournalRoot(agentDir), "clash"), "utf8")).toBe("adopted-file");
    expect(result.quarantined).toHaveLength(1);
    expect(readFileSync(join(result.quarantined[0]!, "inner.json"), "utf8")).toBe("legacy-tree");
    expect(existsSync(join(agentDir, "provider-journal"))).toBe(false);
  });
});
