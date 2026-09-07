import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionStorageDirs } from "./session-storage.js";
import { buildSessionUsageReport } from "./session-usage-report.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVED_ID = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];

function messageEntry(
  id: string,
  usage: Record<string, unknown>,
  options: { timestamp?: string; provider?: string; model?: string } = {},
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: options.timestamp ?? "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      usage,
    },
  });
}

function usage(totalTokens: number, totalCost: number) {
  return {
    input: totalTokens - 2,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 1,
    totalTokens,
    cost: {
      input: totalCost / 2,
      output: totalCost / 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: totalCost,
    },
  };
}

async function createFixture() {
  const agentDir = join(tmpdir(), `piabyss-usage-${Date.now()}-${Math.random()}`);
  roots.push(agentDir);
  const cwd = join(agentDir, "workspace");
  const dirs = sessionStorageDirs(agentDir, cwd);
  await Promise.all([
    mkdir(dirs.activeDir, { recursive: true }),
    mkdir(dirs.archiveDir, { recursive: true }),
  ]);
  return { agentDir, cwd, dirs };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session usage report", () => {
  it("aggregates active and archived session JSONL files", async () => {
    const fixture = await createFixture();
    const activePath = join(fixture.dirs.activeDir, "active.jsonl");
    const archivedPath = join(fixture.dirs.archiveDir, "archived.jsonl");
    await writeFile(
      activePath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: ACTIVE_ID,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: fixture.cwd,
        }),
        JSON.stringify({ type: "session_info", name: "Active session" }),
        messageEntry("55555555-5555-4555-8555-555555555555", usage(12, 0.03), {
          provider: "anthropic",
          model: "claude-sonnet",
        }),
      ].join("\n"),
    );
    await writeFile(
      archivedPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: ARCHIVED_ID,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: fixture.cwd,
        }),
        messageEntry("66666666-6666-4666-8666-666666666666", usage(8, 0)),
      ].join("\n"),
    );

    const report = await buildSessionUsageReport({
      agentDir: fixture.agentDir,
      canonicalCwd: fixture.cwd,
      workspaceId: WORKSPACE_ID,
      providerNames: new Map([["anthropic", "Anthropic"]]),
    });

    expect(report.totals.sessionCount).toBe(2);
    expect(report.totals.messageCount).toBe(2);
    expect(report.totals.usage.totalTokens).toBe(20);
    expect(report.totals.usage.reasoning).toBe(2);
    expect(report.totals.usage.cost.total).toBeCloseTo(0.03);
    expect(report.models).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-sonnet",
        sessionCount: 1,
        providerName: "Anthropic",
        usage: expect.objectContaining({ totalTokens: 12 }),
      }),
    ]);
    expect(report.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: ACTIVE_ID, name: "Active session", archived: false }),
        expect.objectContaining({ sessionId: ARCHIVED_ID, archived: true }),
      ]),
    );
  });

  it("filters usage by the requested date range", async () => {
    const fixture = await createFixture();
    const sessionPath = join(fixture.dirs.activeDir, "active.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session", version: 3, id: ACTIVE_ID, cwd: fixture.cwd }),
        messageEntry("old", usage(12, 0), { timestamp: "2026-01-01T00:00:00.000Z" }),
        messageEntry("new", usage(8, 0), {
          timestamp: "2026-01-10T12:00:00.000Z",
          provider: "openai",
          model: "gpt-4.1",
        }),
      ].join("\n"),
    );

    const report = await buildSessionUsageReport({
      agentDir: fixture.agentDir,
      canonicalCwd: fixture.cwd,
      workspaceId: WORKSPACE_ID,
      range: "7d",
      now: new Date("2026-01-10T15:00:00.000Z").getTime(),
    });

    expect(report.totals.usage.totalTokens).toBe(8);
    expect(report.models?.[0]).toMatchObject({ provider: "openai", modelId: "gpt-4.1" });
  });

  it("reparses a session after its mtime changes", async () => {
    const fixture = await createFixture();
    const sessionPath = join(fixture.dirs.activeDir, "active.jsonl");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: ACTIVE_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: fixture.cwd,
    });
    await writeFile(
      sessionPath,
      [header, messageEntry("55555555-5555-4555-8555-555555555555", usage(12, 0.03))].join("\n"),
    );
    const first = await buildSessionUsageReport({
      agentDir: fixture.agentDir,
      canonicalCwd: fixture.cwd,
      workspaceId: WORKSPACE_ID,
    });
    expect(first.totals.usage.totalTokens).toBe(12);

    await writeFile(
      sessionPath,
      [header, messageEntry("55555555-5555-4555-8555-555555555555", usage(24, 0.06))].join("\n"),
    );
    const future = new Date(Date.now() + 2_000);
    await utimes(sessionPath, future, future);
    const second = await buildSessionUsageReport({
      agentDir: fixture.agentDir,
      canonicalCwd: fixture.cwd,
      workspaceId: WORKSPACE_ID,
    });
    expect(second.totals.usage.totalTokens).toBe(24);
    expect(second.totals.usage.cost.total).toBeCloseTo(0.06);
  });
});
