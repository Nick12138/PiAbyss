import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPresentFilesTool } from "./present-files-tool.js";

const root = await mkdtemp(join(tmpdir(), "piabyss-present-files-"));
const existing = join(root, "report.md");

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("piabyss_present_files tool", () => {
  const signal = () => new AbortController().signal;

  it("records delivered files and echoes them back", async () => {
    const tool = buildPresentFilesTool();
    const result = await tool.execute(
      "call-1",
      { files: [{ path: "docs/spec.docx" }, { path: "README.md", label: "README" }] },
      signal(),
      () => undefined,
      {} as never,
    );
    expect((result.content[0] as { text: string }).text).toContain("Recorded 2 delivered file(s)");
    expect((result.content[0] as { text: string }).text).toContain("- docs/spec.docx");
    expect((result.content[0] as { text: string }).text).toContain("- README.md (README)");
  });

  it("warns about declared paths that do not exist yet", async () => {
    await writeFile(existing, "# report\n", "utf8");
    const tool = buildPresentFilesTool(() => root);
    const result = await tool.execute(
      "call-2",
      { files: [{ path: "report.md" }, { path: "missing.md" }] },
      signal(),
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("missing.md");
    expect(text).not.toContain("report.md, missing.md");
  });

  it("rejects an empty path without touching the filesystem", async () => {
    const tool = buildPresentFilesTool(() => root);
    const result = await tool.execute(
      "call-3",
      { files: [{ path: "   " }] },
      signal(),
      () => undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("non-empty `path`"),
    });
  });
});
