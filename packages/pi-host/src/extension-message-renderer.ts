import { stripVTControlCharacters } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  MAX_EXTENSION_MESSAGE_RENDER_CHARACTERS,
  MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH,
  MAX_EXTENSION_MESSAGE_RENDER_LINES,
  type ExtensionMessageRenderSnapshot,
} from "@piabyss/protocol";
import { createDesktopExtensionTheme } from "./extension-rendering-theme.js";

const MESSAGE_RENDER_WIDTH = 100;

type CustomMessageEntryLike = {
  id: string;
  type: string;
  customType?: unknown;
  content?: unknown;
  display?: unknown;
  details?: unknown;
  timestamp?: unknown;
  summary?: unknown;
};

function contextMessageCount(entry: CustomMessageEntryLike): number {
  if (entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction") {
    return 1;
  }
  return entry.type === "branch_summary" && Boolean(entry.summary) ? 1 : 0;
}

function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}

function sanitizeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  let characters = 0;
  let truncated = false;
  for (const rawLine of value) {
    if (lines.length >= MAX_EXTENSION_MESSAGE_RENDER_LINES) {
      truncated = true;
      break;
    }
    const line = stripVTControlCharacters(String(rawLine))
      .replaceAll("\r", "")
      .replace(/[ \t]+$/u, "")
      .slice(0, MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH);
    const remaining = MAX_EXTENSION_MESSAGE_RENDER_CHARACTERS - characters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    lines.push(line.slice(0, remaining));
    characters += Math.min(line.length, remaining);
    if (line.length > remaining) {
      truncated = true;
      break;
    }
  }
  const trimmed = trimEmptyEdges(lines);
  if (truncated && trimmed.length < MAX_EXTENSION_MESSAGE_RENDER_LINES) trimmed.push("...");
  return trimmed;
}

function timestampForEntry(entry: CustomMessageEntryLike): number {
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    return entry.timestamp;
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function renderMode(
  session: AgentSession,
  entry: CustomMessageEntryLike,
  expanded: boolean,
): string[] | undefined {
  if (typeof entry.customType !== "string") return undefined;
  const renderer = session.extensionRunner.getMessageRenderer(entry.customType);
  if (!renderer) return undefined;
  const component = renderer(
    {
      role: "custom",
      customType: entry.customType,
      content:
        typeof entry.content === "string" || Array.isArray(entry.content)
          ? entry.content
          : "",
      display: entry.display === true,
      details: entry.details,
      timestamp: timestampForEntry(entry),
    } as never,
    { expanded, outputPad: 0 },
    createDesktopExtensionTheme(),
  );
  if (!component) return undefined;
  try {
    return sanitizeLines(component.render(MESSAGE_RENDER_WIDTH));
  } finally {
    const disposable = component as typeof component & { dispose?: () => void };
    disposable.dispose?.();
  }
}

export function renderExtensionMessageEntry(
  session: AgentSession,
  entry: CustomMessageEntryLike,
): ExtensionMessageRenderSnapshot | undefined {
  if (entry.type !== "custom_message" || entry.display !== true) return undefined;
  const collapsed = renderMode(session, entry, false);
  const expanded = renderMode(session, entry, true);
  if (!collapsed && !expanded) return undefined;
  const effectiveCollapsed = collapsed?.length ? collapsed : expanded ?? [];
  const effectiveExpanded = expanded?.length ? expanded : collapsed ?? [];
  if (effectiveCollapsed.length === 0 && effectiveExpanded.length === 0) return undefined;
  return {
    version: 1,
    collapsed: effectiveCollapsed,
    expanded: effectiveExpanded,
  };
}

export function renderExtensionMessageEntries(
  session: AgentSession,
  entries: readonly CustomMessageEntryLike[],
  onError?: (entry: CustomMessageEntryLike, error: unknown) => void,
): Record<string, ExtensionMessageRenderSnapshot> {
  const renders: Record<string, ExtensionMessageRenderSnapshot> = {};
  let messageIndex = 0;
  for (const entry of entries) {
    try {
      const render = renderExtensionMessageEntry(session, entry);
      if (render) renders[entry.id] = { ...render, messageIndex };
    } catch (error) {
      onError?.(entry, error);
    }
    messageIndex += contextMessageCount(entry);
  }
  return renders;
}

export function extensionMessageRenderEqual(
  left: ExtensionMessageRenderSnapshot | undefined,
  right: ExtensionMessageRenderSnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.version === right.version &&
    left.messageIndex === right.messageIndex &&
    left.collapsed.length === right.collapsed.length &&
    left.expanded.length === right.expanded.length &&
    left.collapsed.every((line, index) => line === right.collapsed[index]) &&
    left.expanded.every((line, index) => line === right.expanded[index])
  );
}
