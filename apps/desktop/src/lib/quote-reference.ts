import { draftKeyForTarget, draftTargetFor, type DraftReference } from "./draft-target";
import { setDraftReferencesPersisted } from "./draft-persistence";
import { useAppStore } from "./stores/app-store";

/** Hard cap for the capsule caption; the chip also ellipsizes via CSS. */
const QUOTE_LABEL_MAX_CHARS = 120;

/**
 * Format a transcript selection as a markdown blockquote so quoting into the
 * composer visually separates the quoted source from the user's own reply.
 */
export function formatQuotedSelection(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines.map((line) => `> ${line}`.trimEnd()).join("\n");
}

/** Single-line capsule caption: the first few characters of the selection. */
function quoteReferenceLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > QUOTE_LABEL_MAX_CHARS
    ? `${collapsed.slice(0, QUOTE_LABEL_MAX_CHARS)}…`
    : collapsed;
}

/**
 * Turn a transcript selection into a quote capsule on the current draft. The
 * composer shows the caption only (ellipsized, full text in the native title
 * tooltip); the blockquote payload is expanded into the outgoing message.
 */
export function addQuoteReference(text: string): void {
  const state = useAppStore.getState();
  const target = draftTargetFor(state.workspace, state.session);
  if (!target) return;
  const payload = formatQuotedSelection(text);
  if (!payload) return;
  const reference: DraftReference = {
    id: `quote:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "quote",
    label: quoteReferenceLabel(text),
    payload,
  };
  const existing = state.draftReferences[draftKeyForTarget(target)] ?? [];
  setDraftReferencesPersisted(target, [...existing, reference]);
}
