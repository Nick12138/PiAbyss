import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  AttachmentParseArgs,
  AttachmentParseProgress,
  AttachmentParseResult,
} from "./attachment-parser.js";

const PARSE_TIMEOUT_MS = 5 * 60_000;

function createParserWorker(args: AttachmentParseArgs): Worker {
  const built = new URL("./attachment-parser-worker.js", import.meta.url);
  const workerData = {
    sourcePath: args.sourcePath,
    outputDir: args.outputDir,
    mediaType: args.mediaType,
  };
  const options = {
    workerData,
    resourceLimits: {
      maxOldGenerationSizeMb: 768,
      maxYoungGenerationSizeMb: 128,
      stackSizeMb: 8,
    },
  };
  if (existsSync(fileURLToPath(built))) return new Worker(built, options);

  // Node 22 can strip erasable TypeScript syntax, but it does not remap a
  // source worker's `.js` imports back to `.ts`. The development bootstrap
  // imports the parser module directly; packaged builds use the compiled worker.
  const parserSource = new URL("./attachment-parser.ts", import.meta.url).href;
  const bootstrap = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      try {
        const { parseAttachment } = await import(${JSON.stringify(parserSource)});
        const result = await parseAttachment({
          ...workerData,
          onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }),
        });
        parentPort.postMessage({ type: "result", result });
      } catch (error) {
        parentPort.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  `;
  return new Worker(bootstrap, { ...options, eval: true });
}

export async function runAttachmentParserWorker(
  args: AttachmentParseArgs,
): Promise<AttachmentParseResult> {
  const worker = createParserWorker(args);

  return new Promise<AttachmentParseResult>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Document parsing timed out after 5 minutes")));
    }, PARSE_TIMEOUT_MS);
    timer.unref?.();

    worker.on(
      "message",
      (message:
        | { type: "progress"; progress: AttachmentParseProgress }
        | { type: "result"; result: AttachmentParseResult }
        | { type: "error"; message: string }) => {
        if (message.type === "progress") args.onProgress?.(message.progress);
        else if (message.type === "result") finish(() => resolve(message.result));
        else finish(() => reject(new Error(message.message)));
      },
    );
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Document parser worker exited with code ${code}`)));
      }
    });
  });
}
