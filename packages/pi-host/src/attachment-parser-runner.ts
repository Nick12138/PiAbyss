import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import type {
  AttachmentParseArgs,
  AttachmentParseProgress,
  AttachmentParseResult,
} from "./attachment-parser.js";

const PARSE_TIMEOUT_MS = 5 * 60_000;
const CHILD_STDERR_TAIL_BYTES = 2048;

type ChildMessage =
  | { type: "progress"; progress: AttachmentParseProgress }
  | { type: "result"; result: AttachmentParseResult }
  | { type: "error"; message: string };

function describeExitCode(code: number | null): string {
  if (code === null) return "terminated by signal";
  if (code >= 0) return String(code);
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const known: Record<number, string> = {
    [0xc0000005]: "STATUS_ACCESS_VIOLATION",
    [0xc00000fd]: "STATUS_STACK_OVERFLOW",
    [0xc0000409]: "STATUS_STACK_BUFFER_OVERRUN (fail-fast)",
    [0xc0000374]: "STATUS_HEAP_CORRUPTION",
    [0xc000041d]: "STATUS_FATAL_USER_CALLBACK_EXCEPTION",
    [0xc0000602]: "STATUS_FAIL_FAST_EXCEPTION",
    [0x80000003]: "STATUS_BREAKPOINT",
  };
  const name = known[code >>> 0];
  return name ? `${code} (${hex} ${name})` : `${code} (${hex})`;
}

function childEntry(): { entry: URL; execArgv: string[] } {
  // Packaged / dev-fast builds execute the compiled dist; a source bootstrap
  // keeps the legacy tsx-served-src mode working.
  const built = new URL("./attachment-parser-child.js", import.meta.url);
  if (existsSync(fileURLToPath(built))) return { entry: built, execArgv: [] };
  const source = new URL("./attachment-parser-child.ts", import.meta.url);
  return { entry: source, execArgv: ["--import", "tsx"] };
}

export async function runAttachmentParserWorker(
  args: AttachmentParseArgs,
): Promise<AttachmentParseResult> {
  // The parser runs in a child PROCESS, not a worker thread: a native crash
  // inside a parsing dependency (V8 worker-teardown races have been observed
  // with pdfjs/mammoth workloads on Windows, nodejs/node#56312 family) then
  // costs one parse instead of the whole Host.
  const startedAt = Date.now();
  let sizeBytes: number | "unknown" = "unknown";
  try {
    const { statSync } = await import("node:fs");
    sizeBytes = statSync(args.sourcePath).size;
  } catch {
    /* source may vanish before stat — parser will surface the real error */
  }
  logger.info("Attachment parse started (child)", {
    mediaType: args.mediaType,
    sizeBytes,
    sourcePath: args.sourcePath,
    outputDir: args.outputDir,
  });

  const { entry, execArgv } = childEntry();
  const child = spawn(
    process.execPath,
    [...execArgv, fileURLToPath(entry), args.sourcePath, args.outputDir, args.mediaType],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  return new Promise<AttachmentParseResult>((resolve, reject) => {
    let settled = false;
    let stderrTail = "";
    let stdoutBuffer = "";

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      operation();
    };

    const timer = setTimeout(() => {
      finish(() => {
        logger.error("Attachment parse timed out (child killed)", {
          mediaType: args.mediaType,
          sizeBytes,
          elapsedMs: Date.now() - startedAt,
          sourcePath: args.sourcePath,
        });
        reject(new Error("Document parsing timed out after 5 minutes"));
      });
    }, PARSE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line.startsWith("##PI_PARSER_JSON##")) continue;
        let message: ChildMessage;
        try {
          message = JSON.parse(line.slice("##PI_PARSER_JSON##".length)) as ChildMessage;
        } catch {
          continue;
        }
        if (message.type === "progress") {
          args.onProgress?.(message.progress);
          continue;
        }
        if (message.type === "result") {
          const elapsedMs = Date.now() - startedAt;
          logger.info("Attachment parse finished (child)", {
            mediaType: args.mediaType,
            sizeBytes,
            elapsedMs,
            status: message.result.status,
            unitCount: message.result.unitCount,
          });
          finish(() => resolve(message.result));
          return;
        }
        finish(() => {
          logger.error("Attachment parser child reported an error", {
            mediaType: args.mediaType,
            sizeBytes,
            elapsedMs: Date.now() - startedAt,
            message: message.message,
          });
          reject(new Error(message.message));
        });
        return;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-CHILD_STDERR_TAIL_BYTES);
    });

    child.once("error", (error) => {
      finish(() => {
        logger.error("Attachment parser child failed to spawn", {
          mediaType: args.mediaType,
          message: error.message,
        });
        reject(new Error(`Failed to start document parser: ${error.message}`));
      });
    });

    child.once("exit", (code) => {
      if (settled) return;
      finish(() => {
        const detail = stderrTail.trim();
        logger.error("Attachment parser child exited before reporting", {
          mediaType: args.mediaType,
          sizeBytes,
          elapsedMs: Date.now() - startedAt,
          exitCode: describeExitCode(code),
          stderrTail: detail || "(empty)",
        });
        const suffix = detail ? ` — ${detail.split("\n").at(-1)}` : "";
        reject(
          new Error(
            `Document parser exited unexpectedly (code ${describeExitCode(code)})${suffix}`,
          ),
        );
      });
    });
  });
}
