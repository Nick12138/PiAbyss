import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, DEFAULT_TOOLS, normalizeSelectedTools } from "./DefaultToolsSetting";

describe("default tool options", () => {
  it("offers every built-in tool pi ships", () => {
    expect([...BUILTIN_TOOLS]).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  });

  it("defaults to the SDK's four standard tools", () => {
    expect([...DEFAULT_TOOLS]).toEqual(["read", "bash", "edit", "write"]);
    expect(normalizeSelectedTools(undefined)).toEqual(["read", "bash", "edit", "write"]);
  });

  it("keeps a stored selection in a stable order", () => {
    expect(normalizeSelectedTools(["ls", "write", "read"])).toEqual(["read", "write", "ls"]);
  });

  it("drops tool names this build does not know", () => {
    expect(normalizeSelectedTools(["read", "future_tool", "bash"])).toEqual(["read", "bash"]);
  });

  it("treats an empty stored selection as empty rather than as the defaults", () => {
    expect(normalizeSelectedTools([])).toEqual([]);
  });
});
