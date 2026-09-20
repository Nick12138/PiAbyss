import type { AttachmentSnapshot, AttachmentUnit } from "./types.js";

const OPEN_TAG = '<piabyss-attachments version="1">';
const CLOSE_TAG = "</piabyss-attachments>";
const BLOCK_PATTERN = /<piabyss-attachments version="1">\s*([\s\S]*?)\s*<\/piabyss-attachments>/gu;
const GUIDE_OPEN_TAG = '<piabyss-attachment-guide version="1">';
const GUIDE_CLOSE_TAG = "</piabyss-attachment-guide>";
const GUIDE_PATTERN =
  /<piabyss-attachment-guide version="1">\s*([\s\S]*?)\s*<\/piabyss-attachment-guide>/gu;

/**
 * PiAbyss-injected reference blocks: prompts the app composes on the user's
 * behalf (memo handling, schedule smart-creation preamble, plan context).
 * They must reach the model verbatim but are display noise everywhere else —
 * session titles, search indexing, the queue row, the copy button — so they
 * are stripped alongside the attachment blocks. The desktop app folds them
 * back into `@`-style reference chips when rendering the transcript.
 */
const INJECTED_BLOCK_PATTERNS: readonly RegExp[] = [
  // Envelope the app wraps around a whole injected payload (reference block
  // plus its instruction). Stripped first: it contains the blocks below.
  /<piabyss-ref\s[^>]*>[\s\S]*?<\/piabyss-ref>/gu,
  /<piabyss-memo\s[^>]*>[\s\S]*?<\/piabyss-memo>/gu,
  /<piabyss-memo-result\s[^>]*>[\s\S]*?<\/piabyss-memo-result>/gu,
  /<schedule-preamble>[\s\S]*?<\/schedule-preamble>/gu,
  /<schedule-job\s[^>]*>[\s\S]*?<\/schedule-job>/gu,
];

/** Remove PiAbyss-injected reference blocks, keeping the user's own text. */
export function stripPiabyssInjectedBlocks(text: string): string {
  let out = text;
  for (const pattern of INJECTED_BLOCK_PATTERNS) out = out.replace(pattern, "");
  // A prepended envelope leaves a blank-line seam behind; drop it so titles and
  // previews never start with an empty line.
  return out.replace(/^[ \t]*\n+/, "");
}

export type AttachmentReference = {
  id: string;
  name: string;
  mediaType: string;
  unit: AttachmentUnit;
  unitCount: number;
  /** Absolute path of the original source file, when the attachment has one. */
  path?: string;
};

function isReference(value: unknown): value is AttachmentReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id) &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item.mediaType === "string" &&
    (item.unit === "page" || item.unit === "chunk") &&
    typeof item.unitCount === "number" &&
    Number.isSafeInteger(item.unitCount) &&
    item.unitCount >= 0 &&
    (item.path === undefined || typeof item.path === "string")
  );
}

export function buildAttachmentReferenceBlock(attachments: readonly AttachmentSnapshot[]): string {
  const items: AttachmentReference[] = attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    unit: attachment.unit ?? (attachment.mediaType === "application/pdf" ? "page" : "chunk"),
    unitCount: attachment.unitCount ?? 0,
    ...(attachment.sourcePath ? { path: attachment.sourcePath } : {}),
  }));
  return `${OPEN_TAG}\n${JSON.stringify(items)}\n${CLOSE_TAG}`;
}

export function parseAttachmentReferences(text: string): AttachmentReference[] {
  const references: AttachmentReference[] = [];
  for (const match of text.matchAll(BLOCK_PATTERN)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "null");
      if (Array.isArray(parsed)) references.push(...parsed.filter(isReference));
    } catch {
      // Malformed user-authored lookalikes remain non-authoritative.
    }
  }
  return references;
}

export function buildAttachmentGuideBlock(text: string): string {
  return `${GUIDE_OPEN_TAG}\n${text.trim()}\n${GUIDE_CLOSE_TAG}`;
}

export function stripAttachmentReferenceBlocks(text: string): string {
  return stripPiabyssInjectedBlocks(
    text.replace(BLOCK_PATTERN, "").replace(GUIDE_PATTERN, ""),
  ).trimEnd();
}

export function preserveAttachmentReferenceBlocks(original: string, visibleText: string): string {
  // Outermost matches win: an injected envelope contains reference blocks, and
  // re-appending both would duplicate the payload.
  const spans = [
    ...original.matchAll(BLOCK_PATTERN),
    ...original.matchAll(GUIDE_PATTERN),
    ...INJECTED_BLOCK_PATTERNS.flatMap((pattern) => [...original.matchAll(pattern)]),
  ]
    .map((match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: match[0],
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const blocks: string[] = [];
  let covered = -1;
  for (const span of spans) {
    if (span.start < covered) continue;
    covered = span.end;
    blocks.push(span.text);
  }
  if (blocks.length === 0) return visibleText;
  return [visibleText.trimEnd(), ...blocks].filter(Boolean).join("\n\n");
}
