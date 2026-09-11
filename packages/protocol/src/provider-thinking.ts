import type { ThinkingLevel, ThinkingLevelMap } from "./types.js";
import { findModelThinkingProfile } from "./model-thinking-profiles.js";

export const DEFAULT_MODEL_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MODEL_MAX_TOKENS = 128_000;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ThinkingCapabilityDetection = {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  source: "provider" | "profile" | "inferred" | "default";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findEffortValues(metadata: unknown): string[] | null {
  if (!isObject(metadata)) return null;
  const capabilities = isObject(metadata.capabilities) ? metadata.capabilities : undefined;
  const candidates = [
    metadata.supported_reasoning_efforts,
    metadata.reasoning_efforts,
    metadata.supportedThinkingLevels,
    capabilities?.supported_reasoning_efforts,
    capabilities?.reasoning_efforts,
    capabilities?.thinking_levels,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
      return candidate as string[];
    }
  }
  return null;
}

function mapEfforts(values: string[]): ThinkingLevelMap | null {
  const aliases: Record<string, ThinkingLevel> = {
    none: "off",
    disabled: "off",
    min: "minimal",
    extra_high: "xhigh",
    "extra-high": "xhigh",
    maximum: "max",
  };
  const mapped = new Map<ThinkingLevel, string>();
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase();
    const level =
      aliases[normalized] ??
      (THINKING_LEVELS.includes(normalized as ThinkingLevel)
        ? (normalized as ThinkingLevel)
        : undefined);
    if (level) mapped.set(level, raw);
  }
  if (mapped.size === 0) return null;
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, mapped.get(level) ?? null]),
  ) as ThinkingLevelMap;
}

export function detectModelThinking(
  modelId: string,
  metadata?: unknown,
): ThinkingCapabilityDetection {
  const providerEfforts = findEffortValues(metadata);
  if (providerEfforts) {
    const thinkingLevelMap = mapEfforts(providerEfforts);
    if (thinkingLevelMap) {
      return { reasoning: true, thinkingLevelMap, source: "provider" };
    }
  }

  const profile = findModelThinkingProfile(modelId);
  if (profile) {
    return {
      reasoning: true,
      thinkingLevelMap: { ...profile.thinkingLevelMap },
      source: "profile",
    };
  }

  const normalizedId = modelId.trim().toLowerCase();
  if (/(?:^|[-_.])(?:non|no)[-_.]?(?:reasoning|thinking)(?:$|[-_.])/i.test(normalizedId)) {
    return { reasoning: false, source: "default" };
  }
  if (/reason|thinking|(^|[-_.])r1($|[-_.])/i.test(normalizedId)) {
    return { reasoning: true, source: "inferred" };
  }
  return { reasoning: false, source: "default" };
}
