import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { openPromise as openZip } from "yauzl";
import {
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_PASTED_TEXT_ATTACHMENT_BYTES,
  parseAttachmentReferences,
  type AttachmentMediaType,
  type AttachmentSnapshot,
  type AttachmentStatus,
  type AttachmentUnit,
} from "@piabyss/protocol";
import { attachmentRoot } from "./piabyss-data.js";
import { runAttachmentParserWorker } from "./attachment-parser-runner.js";
import type { AttachmentParseArgs, AttachmentParseResult } from "./attachment-parser.js";
import { logger } from "./logger.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const METADATA_FILE = "metadata.json";
const MAX_DOCX_ENTRIES = 10_000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type AttachmentMetadata = {
  version: 1;
  id: string;
  name: string;
  sourceFile: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  sha256: string;
  status: AttachmentStatus;
  unit?: AttachmentUnit;
  unitCount?: number;
  processedUnits?: number;
  error?: string;
  references: string[];
  committed: boolean;
  createdAt: number;
  updatedAt: number;
  /** Absolute path of the original source file (set for path attachments). */
  sourcePath?: string;
};

export type AttachmentReadResult = {
  attachmentId: string;
  name: string;
  mediaType: AttachmentMediaType;
  unit: AttachmentUnit;
  start: number;
  end: number;
  total: number;
  content: string;
  hasMore: boolean;
  truncated: boolean;
};

export type AttachmentParser = (args: AttachmentParseArgs) => Promise<AttachmentParseResult>;

export class AttachmentStoreError extends Error {
  constructor(
    readonly kind:
      "invalid" | "not_found" | "unauthorized" | "not_ready" | "unsupported" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

type AttachmentStoreOptions = {
  agentDir: string;
  parser?: AttachmentParser;
};

function metadataSnapshot(metadata: AttachmentMetadata): AttachmentSnapshot {
  return {
    id: metadata.id,
    name: metadata.name,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    status: metadata.status,
    ...(metadata.unit ? { unit: metadata.unit } : {}),
    ...(metadata.unitCount !== undefined ? { unitCount: metadata.unitCount } : {}),
    ...(metadata.processedUnits !== undefined ? { processedUnits: metadata.processedUnits } : {}),
    ...(metadata.error ? { error: metadata.error } : {}),
    ...(metadata.sourcePath ? { sourcePath: metadata.sourcePath } : {}),
  };
}

function normalizeParserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypted/iu.test(message)) return "Password-protected documents are not supported";
  if (/invalid pdf|missing pdf|bad xref|formaterror/iu.test(message)) {
    return "The PDF is damaged or uses an unsupported structure";
  }
  return message || "Document parsing failed";
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function validateDocxContainer(path: string): Promise<void> {
  const zip = await openZip(path, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  let entries = 0;
  let uncompressedBytes = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  try {
    for await (const entry of zip.eachEntry()) {
      entries += 1;
      uncompressedBytes += entry.uncompressedSize;
      if (entries > MAX_DOCX_ENTRIES || uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
        throw new AttachmentStoreError("too_large", "DOCX expanded content exceeds safety limits");
      }
      if (entry.isEncrypted()) {
        throw new AttachmentStoreError("unsupported", "Encrypted DOCX files are not supported");
      }
      if (entry.fileName === "[Content_Types].xml") hasContentTypes = true;
      if (entry.fileName === "word/document.xml") hasDocument = true;
    }
  } finally {
    zip.close();
  }
  if (!hasContentTypes || !hasDocument) {
    throw new AttachmentStoreError("unsupported", "The selected file is not a valid DOCX document");
  }
}

async function detectMediaType(path: string): Promise<AttachmentMediaType> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(1_024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const view = header.subarray(0, bytesRead);
    if (view.indexOf(Buffer.from("%PDF-")) >= 0) return "application/pdf";
    if (view.length >= 4 && view[0] === 0x50 && view[1] === 0x4b) {
      try {
        await validateDocxContainer(path);
      } catch (error) {
        if (error instanceof AttachmentStoreError) throw error;
        throw new AttachmentStoreError(
          "unsupported",
          "The selected file is not a valid DOCX document",
        );
      }
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
  } finally {
    await handle.close();
  }
  throw new AttachmentStoreError("unsupported", "Only genuine PDF and DOCX files are supported");
}

function validateMetadata(value: unknown, expectedId: string): AttachmentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Attachment metadata is invalid");
  }
  const item = value as Partial<AttachmentMetadata>;
  if (
    item.version !== 1 ||
    item.id !== expectedId ||
    typeof item.name !== "string" ||
    typeof item.sourceFile !== "string" ||
    typeof item.mediaType !== "string" ||
    typeof item.sizeBytes !== "number" ||
    typeof item.sha256 !== "string" ||
    typeof item.status !== "string" ||
    !Array.isArray(item.references) ||
    !item.references.every((reference) => typeof reference === "string") ||
    typeof item.committed !== "boolean" ||
    typeof item.createdAt !== "number" ||
    typeof item.updatedAt !== "number" ||
    (item.sourcePath !== undefined && typeof item.sourcePath !== "string")
  ) {
    throw new Error("Attachment metadata is incomplete");
  }
  return item as AttachmentMetadata;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function pastedTextFileName(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-")
    .replace(".", "-")
    .replace("Z", "");
  return `pasted-text-${stamp}.txt`;
}

export class AttachmentStore {
  readonly root: string;
  private readonly parser: AttachmentParser;
  private readonly removedIds = new Set<string>();
  private readonly pendingParseTasks = new Set<Promise<void>>();
  /**
   * PDF.js and Mammoth can each use a substantial amount of memory even
   * though parsing happens in worker threads. Keep parsing serialized per Host
   * so a burst of dropped documents cannot create several 256 MiB workers at
   * once and take down the whole Node process.
   */
  private parseQueue: Promise<void> = Promise.resolve();

  constructor(options: AttachmentStoreOptions) {
    this.root = attachmentRoot(options.agentDir);
    this.parser = options.parser ?? runAttachmentParserWorker;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    if (process.platform !== "win32") await chmod(this.root, DIR_MODE);
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-")) {
        await rm(join(this.root, entry.name), { recursive: true, force: true });
        continue;
      }
      if (!entry.isDirectory() || !ATTACHMENT_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await this.loadMetadata(entry.name);
        if (!metadata.committed || metadata.references.length === 0) {
          await rm(this.attachmentDir(entry.name), { recursive: true, force: true });
        } else if (metadata.status === "copying" || metadata.status === "parsing") {
          metadata.status = "failed";
          metadata.error = "Document parsing was interrupted; remove and attach the file again";
          await this.saveMetadata(metadata);
        }
      } catch {
        await rm(this.attachmentDir(entry.name), { recursive: true, force: true });
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingParseTasks.size > 0) {
      await Promise.all(this.pendingParseTasks);
    }
  }

  async create(args: {
    sourcePath: string;
    sessionId: string;
    onChange?: (snapshot: AttachmentSnapshot) => void;
  }): Promise<AttachmentSnapshot> {
    const requestedPath = args.sourcePath.trim();
    if (!requestedPath || !isAbsolute(requestedPath)) {
      throw new AttachmentStoreError("invalid", "Attachment path is invalid");
    }
    if (process.platform === "win32" && /^(?:\\\\|\/\/)/u.test(requestedPath)) {
      throw new AttachmentStoreError("invalid", "Network attachment paths are not allowed");
    }
    const sourcePath = await realpath(requestedPath).catch(() => {
      throw new AttachmentStoreError("not_found", "The selected file no longer exists");
    });
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new AttachmentStoreError("invalid", "The selected path is not a regular file");
    }
    if (sourceStat.size <= 0) {
      throw new AttachmentStoreError("invalid", "Empty documents are not supported");
    }
    // Managed attachments are deliberately bounded because this endpoint
    // copies and parses the file. The desktop routes larger documents to a
    // path-only attachment instead of calling this conversion pipeline.
    if (sourceStat.size > MAX_AGENT_ATTACHMENT_BYTES) {
      throw new AttachmentStoreError("too_large", "Document exceeds the 50 MiB file limit");
    }
    const mediaType = await detectMediaType(sourcePath);
    const id = randomUUID();
    const directory = this.attachmentDir(id);
    const sourceFile = mediaType === "application/pdf" ? "source.pdf" : "source.docx";
    await mkdir(directory, { recursive: false, mode: DIR_MODE });
    if (process.platform !== "win32") await chmod(directory, DIR_MODE);
    const now = Date.now();
    const metadata: AttachmentMetadata = {
      version: 1,
      id,
      name: basename(sourcePath),
      sourceFile,
      mediaType,
      sizeBytes: sourceStat.size,
      sha256: "",
      status: "copying",
      references: [args.sessionId],
      committed: false,
      createdAt: now,
      updatedAt: now,
      sourcePath,
    };
    await this.saveMetadata(metadata);
    this.publishChange(metadata, args.onChange);
    try {
      const copiedPath = join(directory, sourceFile);
      await copyFile(sourcePath, copiedPath);
      if (process.platform !== "win32") await chmod(copiedPath, FILE_MODE);
      const copiedStat = await stat(copiedPath);
      if (copiedStat.size !== sourceStat.size) throw new Error("Attachment changed while copying");
      const copiedType = await detectMediaType(copiedPath);
      if (copiedType !== mediaType) throw new Error("Attachment type changed while copying");
      metadata.sha256 = await sha256(copiedPath);
      metadata.status = "parsing";
      metadata.unit = mediaType === "application/pdf" ? "page" : "chunk";
      metadata.processedUnits = 0;
      await this.saveMetadata(metadata);
      this.publishChange(metadata, args.onChange);
      this.startParse(metadata, args.onChange);
      return metadataSnapshot(metadata);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async createText(args: {
    text: string;
    sessionId: string;
    onChange?: (snapshot: AttachmentSnapshot) => void;
  }): Promise<AttachmentSnapshot> {
    const sizeBytes = Buffer.byteLength(args.text, "utf8");
    if (args.text.trim().length === 0) {
      throw new AttachmentStoreError("invalid", "Pasted text must not be empty");
    }
    if (args.text.includes("\u0000")) {
      throw new AttachmentStoreError("invalid", "Pasted text must not contain NUL characters");
    }
    if (sizeBytes > MAX_PASTED_TEXT_ATTACHMENT_BYTES) {
      throw new AttachmentStoreError("too_large", "Pasted text exceeds the 1 MiB limit");
    }

    const id = randomUUID();
    const directory = this.attachmentDir(id);
    const sourceFile = "source.txt";
    await mkdir(directory, { recursive: false, mode: DIR_MODE });
    if (process.platform !== "win32") await chmod(directory, DIR_MODE);
    const now = Date.now();
    const metadata: AttachmentMetadata = {
      version: 1,
      id,
      name: pastedTextFileName(new Date(now)),
      sourceFile,
      mediaType: "text/plain",
      sizeBytes,
      sha256: "",
      status: "copying",
      references: [args.sessionId],
      committed: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveMetadata(metadata);
    this.publishChange(metadata, args.onChange);
    try {
      const sourcePath = join(directory, sourceFile);
      await writeFile(sourcePath, args.text, { encoding: "utf8", mode: FILE_MODE });
      if (process.platform !== "win32") await chmod(sourcePath, FILE_MODE);
      metadata.sha256 = await sha256(sourcePath);
      metadata.status = "parsing";
      metadata.unit = "chunk";
      metadata.processedUnits = 0;
      await this.saveMetadata(metadata);
      this.publishChange(metadata, args.onChange);
      this.startParse(metadata, args.onChange);
      return metadataSnapshot(metadata);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async get(attachmentId: string, sessionId: string): Promise<AttachmentSnapshot> {
    const metadata = await this.authorizedMetadata(attachmentId, sessionId);
    return metadataSnapshot(metadata);
  }

  async removeDraft(attachmentId: string, sessionId: string): Promise<void> {
    const metadata = await this.authorizedMetadata(attachmentId, sessionId);
    if (metadata.committed) {
      throw new AttachmentStoreError(
        "invalid",
        "Attachment is already part of session history and cannot be removed",
      );
    }
    this.removedIds.add(attachmentId);
    await rm(this.attachmentDir(attachmentId), { recursive: true, force: true });
  }

  async prepareForPrompt(
    attachmentIds: readonly string[] | undefined,
    sessionId: string,
  ): Promise<AttachmentSnapshot[]> {
    if (!attachmentIds?.length) return [];
    const snapshots: AttachmentSnapshot[] = [];
    for (const id of new Set(attachmentIds)) {
      const metadata = await this.authorizedMetadata(id, sessionId);
      if (metadata.status !== "ready" && metadata.status !== "needs_ocr") {
        throw new AttachmentStoreError("not_ready", `${metadata.name} is not ready`);
      }
      snapshots.push(metadataSnapshot(metadata));
    }
    return snapshots;
  }

  async commitToSession(attachmentIds: readonly string[], sessionId: string): Promise<void> {
    for (const attachmentId of new Set(attachmentIds)) {
      const metadata = await this.authorizedMetadata(attachmentId, sessionId);
      if (!metadata.committed) {
        metadata.committed = true;
        await this.saveMetadata(metadata);
      }
    }
  }

  async read(args: {
    attachmentId: string;
    sessionId: string;
    start?: number;
    limit?: number;
  }): Promise<AttachmentReadResult> {
    const metadata = await this.authorizedMetadata(args.attachmentId, args.sessionId);
    if (metadata.status === "needs_ocr") {
      throw new AttachmentStoreError(
        "not_ready",
        `${metadata.name} is a scanned PDF without a text layer; extract text from its original file via OCR instead of read_attachment`,
      );
    }
    if (metadata.status !== "ready" || !metadata.unit || metadata.unitCount === undefined) {
      throw new AttachmentStoreError("not_ready", "Attachment parsing is not complete");
    }
    const start = args.start ?? 1;
    const limit = args.limit ?? 5;
    if (!Number.isSafeInteger(start) || start < 1) {
      throw new AttachmentStoreError("invalid", "start must be a positive integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new AttachmentStoreError("invalid", "limit must be between 1 and 10");
    }
    if (metadata.unitCount === 0 || start > metadata.unitCount) {
      throw new AttachmentStoreError("invalid", "Requested attachment range is out of bounds");
    }
    const requestedEnd = Math.min(metadata.unitCount, start + limit - 1);
    const sections: string[] = [];
    let end = start - 1;
    let truncated = false;
    for (let index = start; index <= requestedEnd; index += 1) {
      const label = metadata.unit === "page" ? `Page ${index}` : `Chunk ${index}`;
      const body = await readFile(this.unitPath(metadata.id, index), "utf8");
      const section = `--- ${label} ---\n${body}`;
      const candidate = [...sections, section].join("\n\n");
      if (Buffer.byteLength(candidate, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
        if (sections.length === 0) {
          sections.push(truncateUtf8(section, MAX_TOOL_OUTPUT_BYTES - 64));
          end = index;
          truncated = true;
        }
        break;
      }
      sections.push(section);
      end = index;
    }
    return {
      attachmentId: metadata.id,
      name: metadata.name,
      mediaType: metadata.mediaType,
      unit: metadata.unit,
      start,
      end,
      total: metadata.unitCount,
      content: sections.join("\n\n"),
      hasMore: end < metadata.unitCount,
      truncated,
    };
  }

  async reconcileSession(sessionId: string, sessionFile: string | null | undefined): Promise<void> {
    if (!sessionFile) return;
    const text = await readFile(sessionFile, "utf8").catch(() => "");
    const attachmentIds = new Set(parseAttachmentReferences(text).map((item) => item.id));
    for (const attachmentId of attachmentIds) {
      try {
        const metadata = await this.loadMetadata(attachmentId);
        if (!metadata.references.includes(sessionId)) metadata.references.push(sessionId);
        metadata.committed = true;
        await this.saveMetadata(metadata);
      } catch {
        // A missing attachment remains visible in history but cannot authorize a read.
      }
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !ATTACHMENT_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await this.loadMetadata(entry.name);
        const references = metadata.references.filter((reference) => reference !== sessionId);
        if (references.length === metadata.references.length) continue;
        if (references.length === 0) {
          this.removedIds.add(metadata.id);
          await rm(this.attachmentDir(metadata.id), { recursive: true, force: true });
        } else {
          metadata.references = references;
          await this.saveMetadata(metadata);
        }
      } catch {
        // Corrupt entries are handled by startup reconciliation.
      }
    }
  }

  async discardSessionDrafts(sessionId: string): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !ATTACHMENT_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await this.loadMetadata(entry.name);
        if (metadata.committed || !metadata.references.includes(sessionId)) continue;
        this.removedIds.add(metadata.id);
        await rm(this.attachmentDir(metadata.id), { recursive: true, force: true });
      } catch {
        // Startup reconciliation handles corrupt entries.
      }
    }
  }

  private attachmentDir(attachmentId: string): string {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
      throw new AttachmentStoreError("invalid", "Attachment ID is invalid");
    }
    return join(this.root, attachmentId);
  }

  private unitPath(attachmentId: string, index: number): string {
    return join(this.attachmentDir(attachmentId), "units", `${String(index).padStart(6, "0")}.txt`);
  }

  private async loadMetadata(attachmentId: string): Promise<AttachmentMetadata> {
    let raw: string;
    try {
      raw = await readFile(join(this.attachmentDir(attachmentId), METADATA_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AttachmentStoreError("not_found", "Attachment was not found");
      }
      throw error;
    }
    return validateMetadata(JSON.parse(raw) as unknown, attachmentId);
  }

  private async authorizedMetadata(
    attachmentId: string,
    sessionId: string,
  ): Promise<AttachmentMetadata> {
    const metadata = await this.loadMetadata(attachmentId);
    if (!metadata.references.includes(sessionId)) {
      throw new AttachmentStoreError("unauthorized", "Attachment does not belong to this session");
    }
    return metadata;
  }

  private async saveMetadata(metadata: AttachmentMetadata): Promise<void> {
    if (this.removedIds.has(metadata.id)) return;
    metadata.updatedAt = Date.now();
    const directory = this.attachmentDir(metadata.id);
    const target = join(directory, METADATA_FILE);
    const temporary = join(directory, `.tmp-${METADATA_FILE}`);
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    await rename(temporary, target).catch(async (error) => {
      if (process.platform !== "win32") throw error;
      await rm(target, { force: true });
      await rename(temporary, target);
    });
    if (process.platform !== "win32") await chmod(target, FILE_MODE);
  }

  private publishChange(
    metadata: AttachmentMetadata,
    onChange?: (snapshot: AttachmentSnapshot) => void,
  ): void {
    if (!onChange) return;
    try {
      onChange(metadataSnapshot(metadata));
    } catch (error) {
      logger.warn("Attachment change listener failed", {
        attachmentId: metadata.id,
        error: normalizeParserError(error),
      });
    }
  }

  private startParse(
    metadata: AttachmentMetadata,
    onChange?: (snapshot: AttachmentSnapshot) => void,
  ): void {
    // Queue the parse rather than starting another memory-heavy worker
    // immediately. The rejection handler on the chain keeps one failed parse
    // from poisoning all subsequent attachments.
    const task = this.parseQueue
      .then(() => this.parse(metadata, onChange))
      .then(
        () => undefined,
        (error: unknown) => {
          try {
            logger.error("Attachment background parse task failed", {
              attachmentId: metadata.id,
              error: normalizeParserError(error),
            });
          } catch {
            // The task must remain terminal even when stderr is no longer writable.
          }
        },
      );
    this.parseQueue = task;
    this.pendingParseTasks.add(task);
    void task.then(() => {
      this.pendingParseTasks.delete(task);
    });
  }

  private async parse(
    metadata: AttachmentMetadata,
    onChange?: (snapshot: AttachmentSnapshot) => void,
  ): Promise<void> {
    try {
      if (this.removedIds.has(metadata.id)) return;
      const outputDir = join(this.attachmentDir(metadata.id), "units");
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true, mode: DIR_MODE });
      let lastPublishedAt = 0;
      let lastPublishedUnits = -1;
      const result = await this.parser({
        sourcePath: join(this.attachmentDir(metadata.id), metadata.sourceFile),
        outputDir,
        mediaType: metadata.mediaType,
        onProgress: (progress) => {
          if (this.removedIds.has(metadata.id)) return;
          metadata.processedUnits = progress.processedUnits;
          if (progress.unitCount !== undefined) metadata.unitCount = progress.unitCount;
          const now = Date.now();
          if (
            progress.processedUnits === progress.unitCount ||
            progress.processedUnits - lastPublishedUnits >= 5 ||
            now - lastPublishedAt >= 250
          ) {
            lastPublishedAt = now;
            lastPublishedUnits = progress.processedUnits;
            this.publishChange(metadata, onChange);
          }
        },
      });
      if (this.removedIds.has(metadata.id)) return;
      metadata.status = result.status;
      metadata.unit = result.unit;
      metadata.unitCount = result.unitCount;
      metadata.processedUnits = result.unitCount;
      delete metadata.error;
      await this.saveMetadata(metadata);
      this.publishChange(metadata, onChange);
    } catch (error) {
      if (this.removedIds.has(metadata.id)) return;
      metadata.status = "failed";
      metadata.error = normalizeParserError(error);
      try {
        await this.saveMetadata(metadata);
      } catch (persistError) {
        if (this.removedIds.has(metadata.id)) return;
        logger.error("Failed to persist attachment parse failure", {
          attachmentId: metadata.id,
          parseError: metadata.error,
          persistError: normalizeParserError(persistError),
        });
        return;
      }
      this.publishChange(metadata, onChange);
    }
  }
}
