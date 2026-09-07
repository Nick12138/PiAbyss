import { describe, expect, it } from "vitest";
import {
  buildAttachmentGuideBlock,
  buildAttachmentReferenceBlock,
  parseAttachmentReferences,
  preserveAttachmentReferenceBlocks,
  stripAttachmentReferenceBlocks,
} from "./attachment-references.js";

const attachment = {
  id: "00000000-0000-4000-8000-000000000006",
  name: 'report "Q2".pdf',
  mediaType: "application/pdf" as const,
  sizeBytes: 1_024,
  status: "ready" as const,
  unit: "page" as const,
  unitCount: 12,
};

describe("attachment reference blocks", () => {
  it("round-trips structured references and strips only the hidden block", () => {
    const block = buildAttachmentReferenceBlock([attachment]);
    const text = `Summarize this.\n\n${block}`;

    expect(parseAttachmentReferences(text)).toEqual([
      {
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        unit: "page",
        unitCount: 12,
      },
    ]);
    expect(stripAttachmentReferenceBlocks(text)).toBe("Summarize this.");
  });

  it("preserves references when queued visible text is edited", () => {
    const original = `Old text\n\n${buildAttachmentReferenceBlock([attachment])}`;
    const next = preserveAttachmentReferenceBlocks(original, "New text");
    expect(stripAttachmentReferenceBlocks(next)).toBe("New text");
    expect(parseAttachmentReferences(next)).toHaveLength(1);
  });

  it("injects the source path into the reference block when present", () => {
    const block = buildAttachmentReferenceBlock([
      { ...attachment, sourcePath: "C:\\docs\\report Q2.pdf" },
    ]);
    const parsed = parseAttachmentReferences(`x\n\n${block}`);
    expect(parsed).toEqual([
      {
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        unit: "page",
        unitCount: 12,
        path: "C:\\docs\\report Q2.pdf",
      },
    ]);
  });

  it("omits the path when the attachment has no source path", () => {
    const block = buildAttachmentReferenceBlock([attachment]);
    expect(block).not.toContain("path");
    expect(parseAttachmentReferences(`x\n\n${block}`)[0]).not.toHaveProperty("path");
  });

  it("ignores malformed and non-UUID reference data", () => {
    const text = '<piabyss-attachments version="1">[{"id":"bad"}]</piabyss-attachments>';
    expect(parseAttachmentReferences(text)).toEqual([]);
  });

  it("strips guide blocks alongside reference blocks", () => {
    const guide = buildAttachmentGuideBlock("OCR instructions for scanned PDFs");
    const text = `Summarize this.\n\n${buildAttachmentReferenceBlock([attachment])}\n\n${guide}`;

    expect(stripAttachmentReferenceBlocks(text)).toBe("Summarize this.");
    expect(parseAttachmentReferences(text)).toHaveLength(1);
  });

  it("strips a standalone guide block", () => {
    const guide = buildAttachmentGuideBlock("优先使用 wpscli");
    expect(stripAttachmentReferenceBlocks(`Question?\n\n${guide}`)).toBe("Question?");
    expect(stripAttachmentReferenceBlocks(guide)).toBe("");
  });

  it("preserves guide blocks in their original order when queued text is edited", () => {
    const guide = buildAttachmentGuideBlock("ocr priority: wpscli first");
    const original = `Old\n\n${guide}\n\n${buildAttachmentReferenceBlock([attachment])}`;
    const next = preserveAttachmentReferenceBlocks(original, "New");

    expect(stripAttachmentReferenceBlocks(next)).toBe("New");
    expect(next.indexOf("piabyss-attachment-guide")).toBeLessThan(
      next.indexOf("piabyss-attachments"),
    );
    expect(next).toContain("wpscli first");
    expect(parseAttachmentReferences(next)).toHaveLength(1);
  });
});
