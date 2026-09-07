import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { AttachmentMediaType, AttachmentStatus, AttachmentUnit } from "@piabyss/protocol";

const FILE_MODE = 0o600;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
const DOCX_CHUNK_BYTES = 40 * 1024;
const TEXT_CHUNK_BYTES = 40 * 1024;
const MAX_PDF_PAGES = 10_000;

export type AttachmentParseProgress = {
  processedUnits: number;
  unitCount?: number;
};

export type AttachmentParseResult = {
  status: Extract<AttachmentStatus, "ready" | "needs_ocr">;
  unit: AttachmentUnit;
  unitCount: number;
};

export type AttachmentParseArgs = {
  sourcePath: string;
  outputDir: string;
  mediaType: AttachmentMediaType;
  onProgress?: (progress: AttachmentParseProgress) => void;
};

function unitPath(outputDir: string, index: number): string {
  return join(outputDir, `${String(index).padStart(6, "0")}.txt`);
}

async function writeUnit(outputDir: string, index: number, text: string): Promise<number> {
  const bytes = Buffer.byteLength(text, "utf8");
  await writeFile(unitPath(outputDir, index), text, { encoding: "utf8", mode: FILE_MODE });
  return bytes;
}

function pdfPageText(items: readonly unknown[]): string {
  const lines: string[] = [];
  let current = "";
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null || !("str" in raw)) continue;
    const item = raw as { str?: unknown; hasEOL?: unknown };
    if (typeof item.str !== "string") continue;
    current += item.str;
    if (item.hasEOL === true) {
      lines.push(current.trimEnd());
      current = "";
    } else if (item.str && !/\s$/u.test(item.str)) {
      current += " ";
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.join("\n").trim();
}

async function parsePdf(args: AttachmentParseArgs): Promise<AttachmentParseResult> {
  const loadingTask = getDocument({
    url: args.sourcePath,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF has too many pages (maximum ${MAX_PDF_PAGES})`);
    }
    args.onProgress?.({ processedUnits: 0, unitCount: document.numPages });
    let extractedBytes = 0;
    let hasVisibleText = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pdfPageText(content.items);
      if (text.length > 0) hasVisibleText = true;
      extractedBytes += await writeUnit(args.outputDir, pageNumber, text);
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error("Extracted PDF text exceeds the 100 MiB safety limit");
      }
      args.onProgress?.({ processedUnits: pageNumber, unitCount: document.numPages });
      page.cleanup();
    }
    return {
      status: hasVisibleText ? "ready" : "needs_ocr",
      unit: "page",
      unitCount: document.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (Buffer.byteLength(remaining, "utf8") > maxBytes) {
    let low = 1;
    let high = remaining.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(remaining.slice(0, middle), "utf8") <= maxBytes) low = middle;
      else high = middle - 1;
    }
    const preferredBreak = remaining.lastIndexOf("\n", low);
    const end = preferredBreak >= Math.floor(low * 0.6) ? preferredBreak : low;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

function chunkDocument(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Buffer.byteLength(candidate, "utf8") <= DOCX_CHUNK_BYTES) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    const split = splitUtf8(paragraph, DOCX_CHUNK_BYTES);
    chunks.push(...split.slice(0, -1));
    current = split.at(-1) ?? "";
  }
  if (current) chunks.push(current);
  return chunks;
}

function utf8Boundary(text: string, maxBytes: number): number {
  let low = 1;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 &&
    low < text.length &&
    /[\uD800-\uDBFF]/u.test(text[low - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(text[low]!)
  ) {
    return low - 1;
  }
  return low;
}

function chunkPlainText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (Buffer.byteLength(remaining, "utf8") > TEXT_CHUNK_BYTES) {
    const hardEnd = utf8Boundary(remaining, TEXT_CHUNK_BYTES);
    const minimumPreferredEnd = Math.floor(hardEnd * 0.6);
    const paragraph = remaining.lastIndexOf("\n\n", Math.max(0, hardEnd - 2));
    const line = remaining.lastIndexOf("\n", Math.max(0, hardEnd - 1));
    const end =
      paragraph >= minimumPreferredEnd
        ? paragraph + 2
        : line >= minimumPreferredEnd
          ? line + 1
          : hardEnd;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function elementChildren(node: unknown): { nodeName: string }[] {
  const children = (node as { childNodes?: ArrayLike<{ nodeName: string }> } | null)
    ?.childNodes;
  return children ? Array.from(children) : [];
}

async function parseDocx(args: AttachmentParseArgs): Promise<AttachmentParseResult> {
  const converted = await mammoth.convertToHtml(
    { path: args.sourcePath },
    {
      externalFileAccess: false,
      ignoreEmptyParagraphs: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    },
  );
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  turndown.remove(["img", "script", "style"]);
  turndown.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content) => ` ${content.trim().replaceAll("|", "\\|")} |`,
  });
  turndown.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => {
      const row = `| ${content.trim()}\n`;
      const parent = (node as unknown as { parentNode?: unknown }).parentNode;
      const firstRow = elementChildren(parent).find(
        (child) => child.nodeName.toLowerCase() === "tr",
      );
      if (firstRow !== node) return row;
      const columns = elementChildren(node).filter((child) =>
        ["th", "td"].includes(child.nodeName.toLowerCase()),
      ).length;
      return `${row}|${" --- |".repeat(columns)}\n`;
    },
  });
  turndown.addRule("table", {
    filter: "table",
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  const markdown = turndown.turndown(converted.value).replace(/^- {2,}/gmu, "- ").trim();
  if (Buffer.byteLength(markdown, "utf8") > MAX_EXTRACTED_BYTES) {
    throw new Error("Extracted DOCX text exceeds the 100 MiB safety limit");
  }
  const chunks = chunkDocument(markdown);
  args.onProgress?.({ processedUnits: 0, unitCount: chunks.length });
  for (let index = 0; index < chunks.length; index += 1) {
    await writeUnit(args.outputDir, index + 1, chunks[index]!);
    args.onProgress?.({ processedUnits: index + 1, unitCount: chunks.length });
  }
  return { status: "ready", unit: "chunk", unitCount: chunks.length };
}

async function parsePlainText(args: AttachmentParseArgs): Promise<AttachmentParseResult> {
  const text = await readFile(args.sourcePath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_BYTES) {
    throw new Error("TXT content exceeds the 100 MiB safety limit");
  }
  const chunks = chunkPlainText(text);
  args.onProgress?.({ processedUnits: 0, unitCount: chunks.length });
  for (let index = 0; index < chunks.length; index += 1) {
    await writeUnit(args.outputDir, index + 1, chunks[index]!);
    args.onProgress?.({ processedUnits: index + 1, unitCount: chunks.length });
  }
  return { status: "ready", unit: "chunk", unitCount: chunks.length };
}

export async function parseAttachment(args: AttachmentParseArgs): Promise<AttachmentParseResult> {
  await mkdir(args.outputDir, { recursive: true, mode: 0o700 });
  if (args.mediaType === "application/pdf") return parsePdf(args);
  if (args.mediaType === "text/plain") return parsePlainText(args);
  return parseDocx(args);
}
