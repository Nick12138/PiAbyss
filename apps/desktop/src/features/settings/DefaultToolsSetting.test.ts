import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, DEFAULT_TOOLS, normalizeSelectedTools } from "./DefaultToolsSetting";

describe("default tool options", () => {
  it("offers every built-in tool pi ships", () => {
    expect([...BUILTIN_TOOLS]).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "powershell",
    ]);
  });

  it("defaults to the SDK's standard tools plus the always-on powershell tool", () => {
    expect([...DEFAULT_TOOLS]).toEqual(["read", "bash", "edit", "write", "powershell"]);
    expect(normalizeSelectedTools(undefined)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "powershell",
    ]);
  });

  it("keeps a stored selection in a stable order", () => {
    expect(normalizeSelectedTools(["ls", "write", "read"])).toEqual([
      "read",
      "write",
      "ls",
      "powershell",
    ]);
  });

  it("drops tool names this build does not know", () => {
    expect(normalizeSelectedTools(["read", "future_tool", "bash"])).toEqual([
      "read",
      "bash",
      "powershell",
    ]);
  });

  it("forces powershell on even when a stored selection omits it", () => {
    expect(normalizeSelectedTools(["read", "bash"])).toEqual(["read", "bash", "powershell"]);
    expect(normalizeSelectedTools([])).toEqual(["powershell"]);
  });
});
