import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PASTED_TEXT_ATTACHMENT_BYTES, type AttachmentSnapshot } from "@piabyss/protocol";
import { parseAttachment } from "./attachment-parser.js";
import { AttachmentStore, AttachmentStoreError } from "./attachment-store.js";
import { logger } from "./logger.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "piabyss-attachments-"));
  tempDirs.push(root);
  return { root, agentDir: join(root, "agent") };
}

function buildPdfPages(texts: readonly (string | undefined)[]): Buffer {
  const pageIds = texts.map((_, index) => 3 + index);
  const contentIds = texts.map((_, index) => 3 + texts.length + index);
  const fontId = 3 + texts.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    ...texts.map(
      (_text, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    ),
    ...texts.map((text) => {
      const escaped = text?.replace(/[()\\]/gu, (character) => `\\${character}`) ?? "";
      const stream = escaped ? `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET` : "";
      return `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`;
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

function buildPdf(text?: string): Buffer {
  return buildPdfPages([text]);
}

async function writeDocx(path: string, body?: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        "</Types>",
    ),
    "[Content_Types].xml",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    ),
    "_rels/.rels",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body>" +
        (body ??
          "<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>" +
            "<w:p><w:r><w:t>Revenue increased.</w:t></w:r></w:p>") +
        "<w:sectPr/>" +
        "</w:body></w:document>",
    ),
    "word/document.xml",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
        "</w:styles>",
    ),
    "word/styles.xml",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
        "</w:numbering>",
    ),
    "word/numbering.xml",
  );
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(path)).once("close", resolve).once("error", reject);
    zip.end();
  });
}

async function createAndWait(
  store: AttachmentStore,
  sourcePath: string,
): Promise<AttachmentSnapshot> {
  let resolveTerminal: (snapshot: AttachmentSnapshot) => void = () => undefined;
  const terminal = new Promise<AttachmentSnapshot>((resolve) => {
    resolveTerminal = resolve;
  });
  const initial = await store.create({
    sourcePath,
    sessionId: SESSION_ID,
    onChange: (snapshot) => {
      if (["ready", "needs_ocr", "failed"].includes(snapshot.status)) resolveTerminal(snapshot);
    },
  });
  if (["ready", "needs_ocr", "failed"].includes(initial.status)) return initial;
  return Promise.race([
    terminal,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("attachment parse test timed out")), 10_000),
    ),
  ]);
}

async function createTextAndWait(
  store: AttachmentStore,
  text: string,
): Promise<AttachmentSnapshot> {
  let resolveTerminal: (snapshot: AttachmentSnapshot) => void = () => undefined;
  const terminal = new Promise<AttachmentSnapshot>((resolve) => {
    resolveTerminal = resolve;
  });
  const initial = await store.createText({
    text,
    sessionId: SESSION_ID,
    onChange: (snapshot) => {
      if (["ready", "failed"].includes(snapshot.status)) resolveTerminal(snapshot);
    },
  });
  if (["ready", "failed"].includes(initial.status)) return initial;
  return Promise.race([
    terminal,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("text attachment parse test timed out")), 10_000),
    ),
  ]);
}

describe("AttachmentStore", () => {
  it("stores pasted text privately and preserves exact Unicode content across chunks", async () => {
    const layout = await tempLayout();
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();
    const text = `  heading 😀\n\n${"界".repeat(15_000)}\n  indented\n`;

    const ready = await createTextAndWait(store, text);
    expect(ready).toMatchObject({
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(text, "utf8"),
      status: "ready",
      unit: "chunk",
    });
    expect(ready.name).toMatch(/^pasted-text-\d{8}-\d{6}-\d{3}\.txt$/u);
    expect(ready.unitCount).toBeGreaterThan(1);
    const sourcePath = join(store.root, ready.id, "source.txt");
    expect(await readFile(sourcePath, "utf8")).toBe(text);
    if (process.platform !== "win32") {
      expect((await stat(sourcePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(store.root, ready.id))).mode & 0o777).toBe(0o700);
    }
    const metadata = JSON.parse(
      await readFile(join(store.root, ready.id, "metadata.json"), "utf8"),
    ) as { sha256?: unknown };
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const unitNames = await readdir(join(store.root, ready.id, "units"));
    const reconstructed = (
      await Promise.all(
        unitNames.sort().map((name) => readFile(join(store.root, ready.id, "units", name), "utf8")),
      )
    ).join("");
    expect(reconstructed).toBe(text);
    await expect(store.get(ready.id, OTHER_SESSION_ID)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("contains terminal metadata failures from background parsing", async () => {
    const layout = await tempLayout();
    const logError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const store = new AttachmentStore({
      agentDir: layout.agentDir,
      parser: async ({ outputDir }) => {
        await rm(join(outputDir, ".."), { recursive: true, force: true });
        return { status: "ready", unit: "chunk", unitCount: 1 };
      },
    });
    await store.initialize();

    const initial = await store.createText({ text: "content", sessionId: SESSION_ID });
    expect(initial.status).toBe("parsing");
    await expect(store.waitForIdle()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "Failed to persist attachment parse failure",
      expect.objectContaining({ attachmentId: initial.id }),
    );
  });

  it("does not let change listener failures corrupt attachment state", async () => {
    const layout = await tempLayout();
    const logWarning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    const initial = await store.createText({
      text: "content",
      sessionId: SESSION_ID,
      onChange: () => {
        throw new Error("listener failed");
      },
    });
    await store.waitForIdle();

    await expect(store.get(initial.id, SESSION_ID)).resolves.toMatchObject({ status: "ready" });
    expect(logWarning).toHaveBeenCalledWith(
      "Attachment change listener failed",
      expect.objectContaining({ attachmentId: initial.id, error: "listener failed" }),
    );
  });

  it("rejects unsafe or oversized pasted text", async () => {
    const layout = await tempLayout();
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    await expect(store.createText({ text: "   ", sessionId: SESSION_ID })).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      store.createText({ text: "before\u0000after", sessionId: SESSION_ID }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      store.createText({
        text: "x".repeat(MAX_PASTED_TEXT_ATTACHMENT_BYTES + 1),
        sessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  it("copies, parses, authorizes, and reads PDF pages", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "report.bin");
    await writeFile(source, buildPdf("Hello PDF attachment"));
    const store = new AttachmentStore({ agentDir: layout.agentDir });
    await store.initialize();

    const ready = await createAndWait(store, source);
    expect(ready.error, ready.error).toBeUndefined();
    expect(ready).toMatchObject({
      name: "report.bin",
      mediaType: "application/pdf",
      status: "ready",
      unit: "page",
      unitCount: 1,
    });
    // The store resolves the requested path (realpath), which on Windows CI
    // can expand an 8.3 short name (RUNNER~1) to the long user path.
    expect(ready.sourcePath).toBe(await realpath(source));
    const result = await store.read({
      attachmentId: ready.id,
      sessionId: SESSION_ID,
      start: 1,
      limit: 5,
    });
    expect(result.content).toContain("Hello PDF attachment");
    await expect(store.get(ready.id, OTHER_SESSION_ID)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("marks image-only PDFs as needing OCR but still allows sending", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "scan.pdf");
    await writeFile(source, buildPdf());
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    const scanned = await createAndWait(store, source);
    expect(scanned).toMatchObject({
      status: "needs_ocr",
      unit: "page",
      unitCount: 1,
    });

    // Scanned PDFs are sendable: prompt preparation must not reject.
    await expect(store.prepareForPrompt([scanned.id], SESSION_ID)).resolves.toMatchObject([
      { id: scanned.id, status: "needs_ocr" },
    ]);

    // Reading the extracted units stays unavailable, with an OCR hint.
    await expect(
      store.read({ attachmentId: scanned.id, sessionId: SESSION_ID }),
    ).rejects.toMatchObject({ kind: "not_ready" });
  });

  it("keeps page boundaries for multi-page PDFs with blank pages", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "multi-page.pdf");
    await writeFile(source, buildPdfPages(["Page one", undefined, "Page three"]));
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    const ready = await createAndWait(store, source);
    expect(ready).toMatchObject({ status: "ready", unit: "page", unitCount: 3 });
    const result = await store.read({
      attachmentId: ready.id,
      sessionId: SESSION_ID,
      start: 1,
      limit: 3,
    });
    expect(result.content).toContain("--- Page 2 ---");
    expect(result.content).toContain("Page one");
    expect(result.content).toContain("Page three");
  });

  it("validates and parses DOCX into logical chunks", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "report.docx");
    await writeDocx(source);
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    const ready = await createAndWait(store, source);
    expect(ready).toMatchObject({ status: "ready", unit: "chunk", unitCount: 1 });
    const result = await store.read({ attachmentId: ready.id, sessionId: SESSION_ID });
    expect(result.content).toContain("Quarterly report");
    expect(result.content).toContain("Revenue increased");
  });

  it("preserves Unicode headings, lists, and table structure from DOCX", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "structured.docx");
    await writeDocx(
      source,
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>' +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>" +
        "<w:tr><w:tc><w:p><w:r><w:t>收入</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    );
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    const ready = await createAndWait(store, source);
    expect(ready).toMatchObject({ status: "ready", unit: "chunk", unitCount: 1 });
    const result = await store.read({ attachmentId: ready.id, sessionId: SESSION_ID });
    expect(result.content).toContain("# 季度报告");
    expect(result.content).toContain("- 第一项");
    expect(result.content).toContain("| 指标 | 数值 |");
    expect(result.content).toContain("| --- | --- |");
    expect(result.content).toContain("| 收入 | 42 |");
  });

  it("reports damaged PDF and ZIP inputs without exposing parser internals", async () => {
    const layout = await tempLayout();
    const damagedPdf = join(layout.root, "damaged.pdf");
    const damagedZip = join(layout.root, "damaged.docx");
    await writeFile(damagedPdf, "%PDF-1.4\nthis is not a complete PDF");
    await writeFile(damagedZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    await expect(createAndWait(store, damagedPdf)).resolves.toMatchObject({
      status: "failed",
      error: "The PDF is damaged or uses an unsupported structure",
    });
    await expect(
      store.create({ sourcePath: damagedZip, sessionId: SESSION_ID }),
    ).rejects.toMatchObject({
      kind: "unsupported",
      message: "The selected file is not a valid DOCX document",
    });
  });

  it("rejects DOCX containers claiming excessive expanded content", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "oversized.docx");
    await writeDocx(source);
    const zip = await readFile(source);
    const centralHeader = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralHeader).toBeGreaterThanOrEqual(0);
    zip.writeUInt32LE(100 * 1024 * 1024 + 1, centralHeader + 24);
    await writeFile(source, zip);
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    await expect(store.create({ sourcePath: source, sessionId: SESSION_ID })).rejects.toMatchObject(
      { kind: "too_large" },
    );
  });

  it("rejects extension-spoofed files and prevents committed draft removal", async () => {
    const layout = await tempLayout();
    const fake = join(layout.root, "fake.pdf");
    await writeFile(fake, "not really a pdf");
    const source = join(layout.root, "real.pdf");
    await writeFile(source, buildPdf("Committed"));
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    await expect(store.create({ sourcePath: fake, sessionId: SESSION_ID })).rejects.toBeInstanceOf(
      AttachmentStoreError,
    );
    const ready = await createAndWait(store, source);
    await store.commitToSession([ready.id], SESSION_ID);
    await expect(store.removeDraft(ready.id, SESSION_ID)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(await readFile(join(store.root, ready.id, "source.pdf"))).toHaveLength(ready.sizeBytes);
  });

  it("cleans abandoned drafts on session switch and startup", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "draft.pdf");
    await writeFile(source, buildPdf("Draft"));
    const store = new AttachmentStore({ agentDir: layout.agentDir, parser: parseAttachment });
    await store.initialize();

    const switched = await createAndWait(store, source);
    await store.discardSessionDrafts(SESSION_ID);
    await expect(store.get(switched.id, SESSION_ID)).rejects.toMatchObject({
      kind: "not_found",
    });

    const restarted = await createAndWait(store, source);
    const reopened = new AttachmentStore({
      agentDir: layout.agentDir,
      parser: parseAttachment,
    });
    await reopened.initialize();
    await expect(reopened.get(restarted.id, SESSION_ID)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("bounds page ranges and individual tool output", async () => {
    const layout = await tempLayout();
    const source = join(layout.root, "large.pdf");
    await writeFile(source, buildPdf("Source"));
    const store = new AttachmentStore({
      agentDir: layout.agentDir,
      parser: async ({ outputDir, onProgress }) => {
        onProgress?.({ processedUnits: 0, unitCount: 12 });
        for (let index = 1; index <= 12; index += 1) {
          await writeFile(
            join(outputDir, `${String(index).padStart(6, "0")}.txt`),
            index === 1 ? "x".repeat(100_000) : `page ${index}`,
          );
          onProgress?.({ processedUnits: index, unitCount: 12 });
        }
        return { status: "ready", unit: "page", unitCount: 12 };
      },
    });
    await store.initialize();
    const ready = await createAndWait(store, source);

    const first = await store.read({ attachmentId: ready.id, sessionId: SESSION_ID });
    expect(first).toMatchObject({ start: 1, end: 1, total: 12, hasMore: true, truncated: true });
    expect(Buffer.byteLength(first.content, "utf8")).toBeLessThanOrEqual(50 * 1024);

    const rest = await store.read({
      attachmentId: ready.id,
      sessionId: SESSION_ID,
      start: 3,
      limit: 10,
    });
    expect(rest).toMatchObject({ start: 3, end: 12, total: 12, hasMore: false });
    await expect(
      store.read({ attachmentId: ready.id, sessionId: SESSION_ID, limit: 11 }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});
