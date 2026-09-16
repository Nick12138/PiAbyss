/**
 * Attachment parser child-process entry.
 *
 * Run as: node attachment-parser-child.js <sourcePath> <outputDir> <mediaType>
 *
 * Protocol: JSON lines on stdout, each prefixed with PARSE_MESSAGE_PREFIX
 * (other stdout output from libraries is ignored). Progress lines stream
 * during parsing; exactly one terminal line (result | error) is emitted.
 * A non-zero exit code without a terminal line means the child died hard
 * (e.g. a native crash in a parsing dependency) — the parent treats that as
 * a recoverable parse failure instead of taking the Host down, which is the
 * entire reason this runs out-of-process.
 */

import { parseAttachment } from "./attachment-parser.js";

export const PARSE_MESSAGE_PREFIX = "##PI_PARSER_JSON##";

const [sourcePath, outputDir, mediaType] = process.argv.slice(2);
if (!sourcePath || !outputDir || !mediaType) {
  console.error("usage: attachment-parser-child <sourcePath> <outputDir> <mediaType>");
  process.exit(2);
}

function emit(payload: unknown): void {
  process.stdout.write(`${PARSE_MESSAGE_PREFIX}${JSON.stringify(payload)}\n`);
}

parseAttachment({
  sourcePath,
  outputDir,
  mediaType: mediaType as Parameters<typeof parseAttachment>[0]["mediaType"],
  onProgress: (progress) => emit({ type: "progress", progress }),
})
  .then((result) => {
    emit({ type: "result", result });
  })
  .catch((error: unknown) => {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
