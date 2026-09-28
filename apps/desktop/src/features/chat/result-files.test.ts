import { describe, expect, it } from "vitest";
import { RESULT_FILES_TOOL_NAME, declaredResultFiles, parseDeclaredFiles } from "./result-files";
import type { TranscriptBlock, ToolTrace } from "./transcript-model";

function toolTrace(overrides: Partial<ToolTrace>): TranscriptBlock {
  return {
    kind: "tool",
    tool: { id: "tool-1", name: RESULT_FILES_TOOL_NAME, status: "done", ...overrides },
  };
}

describe("parseDeclaredFiles", () => {
  it("keeps only entries with a usable path", () => {
    expect(
      parseDeclaredFiles({
        files: [
          { path: " reports/report.md ", label: " 汇总报告 " },
          { path: "   " },
          { label: "no path" },
          "not an object",
          null,
        ],
      }),
    ).toEqual([{ path: "reports/report.md", label: "汇总报告" }]);
  });

  it("returns nothing for malformed arguments", () => {
    expect(parseDeclaredFiles(undefined)).toEqual([]);
    expect(parseDeclaredFiles("files")).toEqual([]);
    expect(parseDeclaredFiles({ files: "a.md" })).toEqual([]);
  });
});

describe("declaredResultFiles", () => {
  it("collects declarations from the turn and deduplicates by path", () => {
    const blocks: TranscriptBlock[] = [
      toolTrace({
        id: "a",
        args: { files: [{ path: "docs/spec.docx" }, { path: "README.md" }] },
      }),
      toolTrace({
        id: "b",
        args: { files: [{ path: "readme.md", label: "README" }] },
      }),
    ];
    expect(declaredResultFiles(blocks)).toEqual([
      { path: "docs/spec.docx", label: undefined },
      { path: "README.md", label: undefined },
    ]);
  });

  it("ignores failed, running and unrelated tool calls", () => {
    const blocks: TranscriptBlock[] = [
      toolTrace({ id: "a", status: "error", args: { files: [{ path: "a.md" }] } }),
      toolTrace({ id: "b", status: "running", args: { files: [{ path: "b.md" }] } }),
      toolTrace({ id: "c", name: "write", args: { path: "c.md" } }),
      { kind: "text", text: "done" },
    ];
    expect(declaredResultFiles(blocks)).toEqual([]);
  });
});
