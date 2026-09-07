import { describe, expect, it } from "vitest";
import type { PackageRecord, PackageSnapshot } from "@piabyss/protocol";
import { isTelegramPluginInstalled, isTelegramPluginRecord } from "./telegram-plugin";

function record(overrides: Partial<PackageRecord>): PackageRecord {
  return {
    id: "p1",
    identity: "npm:@llblab/pi-telegram",
    source: "npm:@llblab/pi-telegram",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "pi-telegram",
    effective: true,
    resourceCounts: null,
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

describe("isTelegramPluginRecord", () => {
  it("matches identity or source case-insensitively when installed", () => {
    expect(isTelegramPluginRecord(record({}))).toBe(true);
    expect(isTelegramPluginRecord(record({ identity: "NPM:@LLBLAB/PI-TELEGRAM" }))).toBe(true);
    expect(isTelegramPluginRecord(record({ identity: "npm:other", source: "npm:other" }))).toBe(false);
  });

  it("requires installed", () => {
    expect(isTelegramPluginRecord(record({ installed: false, installedPath: undefined }))).toBe(false);
  });
});

describe("isTelegramPluginInstalled", () => {
  it("checks the snapshot's configured list", () => {
    const snapshot = { configured: [record({})] } as unknown as PackageSnapshot;
    expect(isTelegramPluginInstalled(snapshot)).toBe(true);
    const empty = { configured: [record({ installed: false })] } as unknown as PackageSnapshot;
    expect(isTelegramPluginInstalled(empty)).toBe(false);
  });
});