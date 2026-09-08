import { describe, expect, it } from "vitest";
import {
  buildPromptCacheFingerprint,
  diffPromptCacheFingerprints,
} from "./prompt-cache-contract.js";

const BASE_INPUT = {
  modelId: "claude-sonnet-4-5",
  provider: "anthropic",
  systemPrompt: "You are a helpful assistant.",
  toolNames: ["read", "bash", "edit"],
  thinkingLevel: "medium",
};

describe("buildPromptCacheFingerprint", () => {
  it("is deterministic for identical input", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint(BASE_INPUT);
    expect(a.hash).toBe(b.hash);
    expect(a.parts).toEqual(b.parts);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits one stable hash per part", () => {
    const fingerprint = buildPromptCacheFingerprint(BASE_INPUT);
    expect(Object.keys(fingerprint.parts).sort()).toEqual([
      "model",
      "systemPrompt",
      "thinkingLevel",
      "tools",
    ]);
    for (const value of Object.values(fingerprint.parts)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("changes the hash and reports tools when tool order changes", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({ ...BASE_INPUT, toolNames: ["bash", "read", "edit"] });
    expect(b.hash).not.toBe(a.hash);
    expect(b.parts.tools).not.toBe(a.parts.tools);
    // Same tool set, only order differs: no other part may drift.
    expect(b.parts.model).toBe(a.parts.model);
    expect(b.parts.systemPrompt).toBe(a.parts.systemPrompt);
    expect(b.parts.thinkingLevel).toBe(a.parts.thinkingLevel);
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual(["tools"]);
  });

  it("detects model drift only", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({ ...BASE_INPUT, modelId: "gpt-5" });
    expect(b.hash).not.toBe(a.hash);
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual(["model"]);
  });

  it("detects provider-only model drift", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({ ...BASE_INPUT, provider: "openrouter" });
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual(["model"]);
  });

  it("detects systemPrompt drift only", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({
      ...BASE_INPUT,
      systemPrompt: "You are a different assistant.",
    });
    expect(b.hash).not.toBe(a.hash);
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual(["systemPrompt"]);
  });

  it("detects thinkingLevel drift only", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({ ...BASE_INPUT, thinkingLevel: "high" });
    expect(b.hash).not.toBe(a.hash);
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual(["thinkingLevel"]);
  });

  it("reports multiple changed parts in stable order", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({
      ...BASE_INPUT,
      modelId: "gpt-5",
      thinkingLevel: "high",
      toolNames: ["edit"],
    });
    // Fixed part order wins over insertion or set order.
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual([
      "model",
      "tools",
      "thinkingLevel",
    ]);
  });

  it("ignores surrounding whitespace in string parts", () => {
    const a = buildPromptCacheFingerprint(BASE_INPUT);
    const b = buildPromptCacheFingerprint({
      ...BASE_INPUT,
      systemPrompt: "  You are a helpful assistant.  ",
      thinkingLevel: " medium ",
    });
    expect(b.hash).toBe(a.hash);
    expect(diffPromptCacheFingerprints(a.parts, b.parts)).toEqual([]);
  });

  it("treats missing and empty fields as identical", () => {
    const empty = buildPromptCacheFingerprint({});
    const blanks = buildPromptCacheFingerprint({
      modelId: "",
      provider: "",
      systemPrompt: "   ",
      toolNames: [],
      thinkingLevel: "",
    });
    expect(empty.hash).toBe(blanks.hash);
    expect(diffPromptCacheFingerprints(empty.parts, blanks.parts)).toEqual([]);
  });
});

describe("diffPromptCacheFingerprints", () => {
  it("returns [] for identical parts maps", () => {
    const fingerprint = buildPromptCacheFingerprint(BASE_INPUT);
    expect(diffPromptCacheFingerprints(fingerprint.parts, fingerprint.parts)).toEqual([]);
  });

  it("handles unknown part names deterministically", () => {
    expect(diffPromptCacheFingerprints({ customB: "1" }, { customA: "2" })).toEqual([
      "customA",
      "customB",
    ]);
  });
});
