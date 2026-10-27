import { describe, expect, it } from "vitest";
import {
  RESULT_FILES_TOOL_NAME,
  RESULT_FILES_TOOL_NAME_LEGACY,
  declaredResultFiles,
  filterRenderableBlocks,
  parseDeclaredFiles,
} from "./result-files";
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

describe("legacy present_files name", () => {
  it("restores chips and hides the tool call for pre-rename sessions", () => {
    const legacy = toolTrace({
      id: "a",
      name: RESULT_FILES_TOOL_NAME_LEGACY,
      args: { files: [{ path: "reports/old.pdf" }] },
    });
    expect(declaredResultFiles([legacy])).toEqual([{ path: "reports/old.pdf", label: undefined }]);
    expect(filterRenderableBlocks([legacy])).toEqual([]);
  });
});

describe("filterRenderableBlocks", () => {
  it("drops the declaration tool but keeps everything else", () => {
    const blocks: TranscriptBlock[] = [
      { kind: "text", text: "working" },
      toolTrace({ id: "a", args: { files: [{ path: "a.md" }] } }),
      toolTrace({ id: "b", name: "write", args: { path: "b.md" } }),
      { kind: "thinking", text: "hmm" },
    ];
    expect(filterRenderableBlocks(blocks)).toEqual([
      { kind: "text", text: "working" },
      toolTrace({ id: "b", name: "write", args: { path: "b.md" } }),
      { kind: "thinking", text: "hmm" },
    ]);
  });
});
