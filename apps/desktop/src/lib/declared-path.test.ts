import { describe, expect, it } from "vitest";
import {
  isAbsoluteDeclaredPath,
  normalizeDeclaredPath,
  relativizeAgainstRoot,
} from "./declared-path";

describe("normalizeDeclaredPath", () => {
  it("trims, unifies separators and drops a leading ./", () => {
    expect(normalizeDeclaredPath("  reports\\spec.docx ")).toBe("reports/spec.docx");
    expect(normalizeDeclaredPath("./report.md")).toBe("report.md");
    expect(normalizeDeclaredPath("report.md/")).toBe("report.md");
    expect(normalizeDeclaredPath("   ")).toBe("");
  });
});

describe("isAbsoluteDeclaredPath", () => {
  it("detects windows drives, UNC and posix roots", () => {
    expect(isAbsoluteDeclaredPath("D:/我的项目/PiAbyss/工具测试文档.pdf")).toBe(true);
    expect(isAbsoluteDeclaredPath("D:\\我的项目\\工具测试文档.docx")).toBe(true);
    expect(isAbsoluteDeclaredPath("//server/share/a.pdf")).toBe(true);
    expect(isAbsoluteDeclaredPath("/tmp/report.pdf")).toBe(true);
    expect(isAbsoluteDeclaredPath("reports/report.pdf")).toBe(false);
    expect(isAbsoluteDeclaredPath("report.md")).toBe(false);
  });
});

describe("relativizeAgainstRoot", () => {
  const root = "D:\\我的项目\\PiAbyss";

  it("relativizes a declared absolute path inside the workspace", () => {
    expect(relativizeAgainstRoot(root, "D:/我的项目/PiAbyss/工具测试文档.pdf")).toBe(
      "工具测试文档.pdf",
    );
    expect(relativizeAgainstRoot(root, "D:\\我的项目\\PiAbyss\\docs\\报告.md")).toBe(
      "docs/报告.md",
    );
  });

  it("is case-insensitive on the drive and folder names", () => {
    expect(relativizeAgainstRoot("d:/我的项目/piabyss", "D:/我的项目/PiAbyss/a.md")).toBe("a.md");
  });

  it("returns null for paths outside the workspace", () => {
    expect(relativizeAgainstRoot(root, "D:/其他项目/工具测试文档.pdf")).toBeNull();
    expect(relativizeAgainstRoot(root, "C:/我的项目/PiAbyss/a.md")).toBeNull();
    expect(relativizeAgainstRoot(root, "D:/我的项目/PiAbyss")).toBeNull();
  });

  it("handles a drive root workspace", () => {
    expect(relativizeAgainstRoot("D:\\", "D:/报告.pdf")).toBe("报告.pdf");
  });
});
