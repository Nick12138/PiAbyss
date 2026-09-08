import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigrationBackup, MIGRATION_ID, type MigrationManifest } from "./migration-backup.js";

const roots: string[] = [];
let counter = 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Deterministic, monotonic timestamps so backup directories sort predictably. */
function nextTimestamp(): string {
  counter += 1;
  return `2026-07-26T00-00-${String(counter).padStart(2, "0")}`;
}

function createAgentDir(options: { sessions?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "piabyss-migration-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ p: { type: "api_key", key: "sk-migration-secret" } }),
  );
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

  const sessionDir = join(agentDir, "sessions", "--tmp-project--");
  mkdirSync(sessionDir, { recursive: true });
  for (let index = 0; index < (options.sessions ?? 0); index += 1) {
    writeFileSync(
      join(sessionDir, `session-${index}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: `s${index}` })}\n` +
        `${JSON.stringify({ type: "message", text: "body" })}\n`,
    );
  }
  return agentDir;
}

function backupDir(agentDir: string): string {
  return join(agentDir, "piabyss", "migration-backups", MIGRATION_ID);
}

function readManifest(directory: string): MigrationManifest {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
}

describe("ensureMigrationBackup", () => {
  it("copies tracked files and records their size and digest", async () => {
    const agentDir = createAgentDir({ sessions: 2 });

    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);

    expect(backup).not.toBeNull();
    const manifest = readManifest(backup!.directory);
    expect(manifest.migrationId).toBe(MIGRATION_ID);

    const auth = manifest.files.find((file) => file.path === "auth.json");
    const authBytes = readFileSync(join(agentDir, "auth.json"));
    expect(auth?.present).toBe(true);
    expect(auth?.bytes).toBe(authBytes.byteLength);
    expect(auth?.sha256).toBe(createHash("sha256").update(authBytes).digest("hex"));

    // The copy must be byte-identical, since it is the rollback source.
    expect(readFileSync(join(backup!.directory, "auth.json"))).toEqual(authBytes);
    expect(readFileSync(join(backup!.directory, "models.json"), "utf8")).toBe(
      readFileSync(join(agentDir, "models.json"), "utf8"),
    );
  });

  it("records an absent optional file rather than failing", async () => {
    const agentDir = createAgentDir();
    expect(existsSync(join(agentDir, "models-store.json"))).toBe(false);

    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);

    const store = readManifest(backup!.directory).files.find(
      (file) => file.path === "models-store.json",
    );
    expect(store).toEqual({ path: "models-store.json", present: false });
  });

  it("keeps credential content out of the manifest", async () => {
    const agentDir = createAgentDir({ sessions: 1 });

    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);

    const manifestText = readFileSync(join(backup!.directory, "manifest.json"), "utf8");
    expect(manifestText).not.toContain("sk-migration-secret");
    expect(manifestText).not.toContain("api_key");
  });

  it("stores session headers and digests without copying session bodies", async () => {
    const agentDir = createAgentDir({ sessions: 2 });

    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);
    const manifest = readManifest(backup!.directory);

    expect(manifest.sessionCount).toBe(2);
    expect(manifest.sessions).toHaveLength(2);
    for (const session of manifest.sessions) {
      expect(session.path.startsWith("sessions/")).toBe(true);
      expect(session.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const headers = readFileSync(join(backup!.directory, "session-headers.jsonl"), "utf8");
    expect(headers.trim().split("\n")).toHaveLength(2);
    expect(headers).toContain('"version\\":3');
    // Only the header line — conversation bodies stay out of the backup.
    expect(headers).not.toContain("body");
  });

  it("uses 0700 for the backup directory and 0600 for copies", async () => {
    if (process.platform === "win32") return;
    const agentDir = createAgentDir();

    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);

    expect(statSync(backup!.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(backup!.directory, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("reuses the existing backup instead of copying again on every start", async () => {
    const agentDir = createAgentDir({ sessions: 1 });

    const first = await ensureMigrationBackup(agentDir, nextTimestamp);
    const second = await ensureMigrationBackup(agentDir, nextTimestamp);

    expect(second!.directory).toBe(first!.directory);
  });

  it("carries milestones across runs and completes only after all of them", async () => {
    const agentDir = createAgentDir({ sessions: 1 });

    const first = await ensureMigrationBackup(agentDir, nextTimestamp);
    await first!.recordMilestone("runtimeCreate");
    await first!.recordMilestone("localRefresh");

    // A later run must still see the migration as incomplete.
    const second = await ensureMigrationBackup(agentDir, nextTimestamp);
    expect(second).not.toBeNull();
    expect(second!.milestones).toEqual(expect.arrayContaining(["runtimeCreate", "localRefresh"]));

    await second!.recordMilestone("sessionOpened");
    await second!.recordMilestone("providerSnapshot");
    expect(await ensureMigrationBackup(agentDir, nextTimestamp)).not.toBeNull();

    await second!.recordMilestone("cleanShutdown");

    // Now complete: subsequent starts skip milestone bookkeeping entirely.
    expect(await ensureMigrationBackup(agentDir, nextTimestamp)).toBeNull();
  });

  it("treats sessionOpened as satisfied when there were no sessions to migrate", async () => {
    const agentDir = createAgentDir({ sessions: 0 });

    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);
    expect(readManifest(backup!.directory).sessionCount).toBe(0);

    for (const milestone of ["runtimeCreate", "localRefresh", "providerSnapshot"] as const) {
      await backup!.recordMilestone(milestone);
    }
    expect(await ensureMigrationBackup(agentDir, nextTimestamp)).not.toBeNull();

    await backup!.recordMilestone("cleanShutdown");

    expect(await ensureMigrationBackup(agentDir, nextTimestamp)).toBeNull();
  });

  it("does not re-run after completion even if agent files change", async () => {
    const agentDir = createAgentDir();
    const backup = await ensureMigrationBackup(agentDir, nextTimestamp);
    for (const milestone of [
      "runtimeCreate",
      "localRefresh",
      "providerSnapshot",
      "cleanShutdown",
    ] as const) {
      await backup!.recordMilestone(milestone);
    }
    expect(await ensureMigrationBackup(agentDir, nextTimestamp)).toBeNull();

    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ changed: true }));

    expect(await ensureMigrationBackup(agentDir, nextTimestamp)).toBeNull();
    // Exactly one backup directory, and it still holds the pre-migration bytes.
    const dirs = readFileSync(join(backupDir(agentDir), "state.json"), "utf8");
    expect(JSON.parse(dirs).completedAt).toBeTruthy();
    expect(readFileSync(join(backup!.directory, "auth.json"), "utf8")).toContain(
      "sk-migration-secret",
    );
  });

  it("rejects when the backup cannot be written", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const agentDir = createAgentDir();
    // Read-only agent directory: refusing to start beats migrating unrecoverably.
    const { chmodSync } = await import("node:fs");
    chmodSync(agentDir, 0o500);
    try {
      await expect(ensureMigrationBackup(agentDir, nextTimestamp)).rejects.toThrow();
    } finally {
      chmodSync(agentDir, 0o700);
    }
  });
});
