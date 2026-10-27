import { describe, expect, it } from "vitest";
import { applyPluginEnvAliases } from "./plugin-env-aliases.js";

describe("applyPluginEnvAliases", () => {
  it("copies legacy PIABYSS_* values onto the generic names", () => {
    const env: NodeJS.ProcessEnv = {
      PIABYSS_MEMO_R2_BUCKET: "memos",
      PIABYSS_PIXIE_WORKSPACE: "D:/pixie",
    };
    expect(applyPluginEnvAliases(env)).toBe(2);
    expect(env.PI_MEMO_R2_BUCKET).toBe("memos");
    expect(env.PI_PIXIE_WORKSPACE).toBe("D:/pixie");
    // Legacy names stay for plugin builds that have not learned the new names.
    expect(env.PIABYSS_MEMO_R2_BUCKET).toBe("memos");
  });

  it("never overrides a generic value that is already set", () => {
    const env: NodeJS.ProcessEnv = {
      PIABYSS_MEMO_R2_BUCKET: "legacy",
      PI_MEMO_R2_BUCKET: "current",
    };
    expect(applyPluginEnvAliases(env)).toBe(0);
    expect(env.PI_MEMO_R2_BUCKET).toBe("current");
  });

  it("ignores empty legacy values", () => {
    const env: NodeJS.ProcessEnv = { PIABYSS_MEMO_AUTO_SYNC: "   " };
    expect(applyPluginEnvAliases(env)).toBe(0);
    expect(env.PI_MEMO_AUTO_SYNC).toBeUndefined();
  });
});
