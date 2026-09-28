import type { TranscriptBlock } from "./transcript-model";

/**
 * `piabyss_present_files` — the host tool the agent calls at the end of a
 * turn to declare the files it actually delivers. The declaration lives in
 * the persisted tool call, so the chips below survive a session reload.
 */
export const RESULT_FILES_TOOL_NAME = "piabyss_present_files";

export type DeclaredResultFile = { path: string; label?: string };

/** Parses the tool's `files` argument defensively. */
export function parseDeclaredFiles(args: unknown): DeclaredResultFile[] {
  if (!args || typeof args !== "object") return [];
  const raw = (args as { files?: unknown }).files;
  if (!Array.isArray(raw)) return [];
  const files: DeclaredResultFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string" || !path.trim()) continue;
    const label = (entry as { label?: unknown }).label;
    files.push({
      path: path.trim(),
      label: typeof label === "string" && label.trim() ? label.trim() : undefined,
    });
  }
  return files;
}

/**
 * Collects every delivered file an assistant turn declared, deduplicated by
 * path. Failed or still-running declarations are skipped.
 */
export function declaredResultFiles(blocks: readonly TranscriptBlock[]): DeclaredResultFile[] {
  const files: DeclaredResultFile[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== "tool") continue;
    const tool = block.tool;
    if (tool.name !== RESULT_FILES_TOOL_NAME) continue;
    if (tool.status !== "done") continue;
    for (const file of parseDeclaredFiles(tool.args)) {
      const key = `${file.path.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
  }
  return files;
}

/**
 * Tool calls that only feed the UI — the chips above — and render as nothing
 * themselves. They stay in the session data; the transcript just skips them.
 */
const RENDER_HIDDEN_TOOLS = new Set([RESULT_FILES_TOOL_NAME]);

export function filterRenderableBlocks(blocks: readonly TranscriptBlock[]): TranscriptBlock[] {
  return blocks.filter(
    (block) => !(block.kind === "tool" && RENDER_HIDDEN_TOOLS.has(block.tool.name)),
  );
}
