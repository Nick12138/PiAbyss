import { describe, expect, it } from "vitest";
import {
  buildAttachmentGuideBlock,
  buildAttachmentReferenceBlock,
  parseAttachmentReferences,
  preserveAttachmentReferenceBlocks,
  stripAttachmentReferenceBlocks,
  stripPiabyssInjectedBlocks,
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

const ENVELOPE = [
  '<piabyss-ref kind="memo" title="修复登录">',
  '<piabyss-memo id="note-1" type="memo" status="open">',
  "# 修复登录",
  "",
  "按钮没反应。",
  "</piabyss-memo>",
  "",
  "请处理上面引用的备忘录记录。",
  "</piabyss-ref>",
].join("\n");

describe("PiAbyss-injected reference blocks", () => {
  it("strips the envelope together with the user's own text", () => {
    expect(stripAttachmentReferenceBlocks(`${ENVELOPE}\n\n帮我看看`)).toBe("帮我看看");
    expect(stripPiabyssInjectedBlocks(`${ENVELOPE}\n\n帮我看看`)).toBe("帮我看看");
  });

  it("strips bare injected blocks from legacy transcripts", () => {
    const memo = '<piabyss-memo id="note-1" type="memo" status="open">\n# t\n</piabyss-memo>';
    const result =
      '<piabyss-memo-result noteId="note-1" sessionId="s-1">\nok\n</piabyss-memo-result>';
    const preamble = "<schedule-preamble>\n你是助手。\n</schedule-preamble>";
    const job = '<schedule-job id="job-1">\n{}\n</schedule-job>';
    const text = [memo, result, preamble, job, "用户需求：\n定时备份"].join("\n\n");

    expect(stripPiabyssInjectedBlocks(text)).toBe("用户需求：\n定时备份");
    expect(stripPiabyssInjectedBlocks(preamble)).toBe("");
  });

  it("leaves plain text and attachment blocks untouched", () => {
    const text = `<attached-path name="a.ts" path="/w/a.ts"/>\n\n看下这个`;
    expect(stripPiabyssInjectedBlocks(text)).toBe(text);
    const reference = buildAttachmentReferenceBlock([attachment]);
    expect(stripAttachmentReferenceBlocks(`看下这个\n\n${text}\n\n${reference}`)).toBe(
      `看下这个\n\n${text}`,
    );
  });

  it("preserves the envelope once, not the nested blocks it contains", () => {
    const next = preserveAttachmentReferenceBlocks(`${ENVELOPE}\n\n旧文本`, "新文本");
    expect(next.startsWith("新文本")).toBe(true);
    expect(next.match(/<piabyss-ref/g)).toHaveLength(1);
    expect(next.match(/<piabyss-memo /g)).toHaveLength(1);
    expect(stripAttachmentReferenceBlocks(next)).toBe("新文本");
  });
});
