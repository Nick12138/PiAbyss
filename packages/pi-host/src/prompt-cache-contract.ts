/**
 * Prompt cache contract (A2): per-request fingerprint reconciliation.
 *
 * Providers KV-cache the immutable prefix of each request. The inputs that
 * shape that prefix on the host side are: model identity (provider + id),
 * the system prompt, the ordered list of active tools, and the thinking
 * level. Any change to them invalidates the provider's cached prefix and
 * re-bills cache writes. These pure helpers let the host fingerprint those
 * inputs per prompt and log drift between consecutive runs — observability
 * only; nothing here mutates request behavior.
 */

import { createHash } from "node:crypto";

/** Stable part ordering for diffs, so log output is deterministic. */
const FINGERPRINT_PART_ORDER = ["model", "systemPrompt", "tools", "thinkingLevel"] as const;

export type PromptCachePartName = (typeof FINGERPRINT_PART_ORDER)[number];

export interface PromptCacheFingerprint {
  /** SHA-256 over the canonical JSON of `parts`. */
  hash: string;
  /** Per-part SHA-256 (hex), keyed by part name. */
  parts: Record<string, string>;
}

export interface PromptCacheFingerprintInput {
  modelId?: string;
  provider?: string;
  systemPrompt?: string;
  /**
   * Active tool names. ORDER IS SIGNIFICANT: the provider serializes tools
   * in request order, so a reorder changes the prompt prefix. Names are
   * intentionally NOT sorted here — only object keys are sorted (in
   * `canonicalJson`), never list elements.
   */
  toolNames?: string[];
  thinkingLevel?: string;
}

/** Normalize a string part: undefined/null → "", otherwise trimmed. */
function normalizeStringPart(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Deterministic JSON encoding: array order preserved, object keys sorted.
 * Lists are never reordered — element order carries meaning (tool order
 * affects the cache prefix); only map keys are normalized.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Fingerprint the inputs that determine the provider prompt-cache prefix.
 * Each part is hashed independently so drift can be attributed per part;
 * the overall hash covers the sorted parts map. Empty/missing fields are
 * normalized to "" so sparse inputs compare equal to blank ones.
 */
export function buildPromptCacheFingerprint(
  input: PromptCacheFingerprintInput,
): PromptCacheFingerprint {
  const parts: Record<string, string> = {
    // Model identity: both provider and id select the endpoint + tokenizer,
    // so they are fingerprinted together as the "model" part.
    model: sha256(
      canonicalJson([normalizeStringPart(input.provider), normalizeStringPart(input.modelId)]),
    ),
    systemPrompt: sha256(canonicalJson(normalizeStringPart(input.systemPrompt))),
    // Tool order preserved verbatim (see toolNames doc above).
    tools: sha256(canonicalJson((input.toolNames ?? []).map(normalizeStringPart))),
    thinkingLevel: sha256(canonicalJson(normalizeStringPart(input.thinkingLevel))),
  };
  return { hash: sha256(canonicalJson(parts)), parts };
}

/**
 * Part names that changed between two fingerprints' parts maps, in stable
 * order (model → systemPrompt → tools → thinkingLevel; unknown/future parts
 * last, alphabetically). Returns [] when the prefixes are identical.
 */
export function diffPromptCacheFingerprints(
  prev: Record<string, string>,
  next: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const ordered = [
    ...FINGERPRINT_PART_ORDER.filter((name) => names.has(name)),
    ...[...names]
      .filter((name) => !(FINGERPRINT_PART_ORDER as readonly string[]).includes(name))
      .sort(),
  ];
  return ordered.filter((name) => prev[name] !== next[name]);
}
