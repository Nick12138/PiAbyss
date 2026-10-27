import { describe, expect, it } from "vitest";
import { legacyPluginIdsFor, migratePluginEnvAliases } from "./plugin-env-migration";

describe("migratePluginEnvAliases", () => {
  it("renames the legacy plugin id and env names in one pass", () => {
    const migrated = migratePluginEnvAliases({
      "piabyss-memo": {
        PIABYSS_MEMO_R2_BUCKET: "memos",
        PIABYSS_MEMO_AUTO_SYNC: "true",
      },
    });
    expect(migrated).toEqual({
      "pi-memo": {
        PI_MEMO_R2_BUCKET: "memos",
        PI_MEMO_AUTO_SYNC: "true",
      },
    });
  });

  it("lets canonical values win over legacy copies", () => {
    const migrated = migratePluginEnvAliases({
      "piabyss-memo": { PIABYSS_PIXIE_WORKSPACE: "D:/legacy" },
      "pi-memo": { PI_PIXIE_WORKSPACE: "D:/current" },
    });
    expect(migrated).toEqual({ "pi-memo": { PI_PIXIE_WORKSPACE: "D:/current" } });
  });

  it("returns null when the map is already canonical", () => {
    expect(migratePluginEnvAliases({ "pi-memo": { PI_MEMO_R2_BUCKET: "memos" } })).toBeNull();
    expect(migratePluginEnvAliases(undefined)).toBeNull();
  });
});

describe("legacyPluginIdsFor", () => {
  it("returns the pre-rename ids for a canonical plugin", () => {
    expect(legacyPluginIdsFor("pi-memo")).toEqual(["piabyss-memo"]);
    expect(legacyPluginIdsFor("pi-pixie")).toEqual([]);
  });
});
