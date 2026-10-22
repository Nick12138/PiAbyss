import { describe, expect, it } from "vitest";
import { buildTranscriptPreamble, parsePixieSegmentsRecap } from "./transcript-preamble";
import type { TranscriptRow } from "./transcript-model";

const RECAP = `<pixie-segments>
你在小精灵工作区开启了一个新的会话段。上一段并没有丢：正文都存在本机 Pi 会话目录里。
要回看细节就调用 pixie_recall（segment 省略 = 上一段；mode=search 可按关键词找）。

最近 2 段（新→旧，序号即 pixie_recall 的 segment 参数，0 = 上一段）：
0. 😀 Qoder反代项目推荐 · 10-19 12:47 · 65 条
1. 💬 下午好问候 · 10-18 09:22 · 2 条

上一段（😀 Qoder反代项目推荐）的收尾：
[1] 10-19 13:52 用户: 面板密码是 0.0
[2] 10-19 14:02 小精灵: 改好了，没走浏览器。
</pixie-segments>`;

const PIXIE_CONTEXT = `<pixie-context>
本段开始时间：2026-10-19（周一）22:09，UTC+8。
- 落点：默认只复用【你自己创建的】会话。
</pixie-context>`;

/** pi-pixie v0.10：契约不再包在首条用户消息外，而是内嵌在交接卡开头。 */
const RECAP_WITH_INLINE_CONTEXT = `<pixie-segments>
${PIXIE_CONTEXT}

你在小精灵工作区开启了一个新的会话段。上一段并没有丢：正文都存在本机 Pi 会话目录里。
要回看细节就调用 pixie_recall（segment 省略 = 上一段；mode=search 可按关键词找）。

最近 2 段（新→旧，序号即 pixie_recall 的 segment 参数，0 = 上一段）：
0. 😀 Qoder反代项目推荐 · 10-19 12:47 · 65 条
1. 💬 下午好问候 · 10-18 09:22 · 2 条

上一段（😀 Qoder反代项目推荐）的收尾：
[1] 10-19 13:52 用户: 面板密码是 0.0
[2] 10-19 14:02 小精灵: 改好了，没走浏览器。
</pixie-segments>`;

function systemRow(key: string, sections: Record<string, string>): TranscriptRow {
  return {
    key,
    role: "event",
    blocks: [],
    copyText: "",
    event: {
      kind: "systemPrompt",
      label: "System prompt",
      details: { role: "system", content: "", sections },
    },
  };
}

function userRow(key: string, text: string): TranscriptRow {
  return { key, role: "user", blocks: [{ kind: "text", text }], copyText: text };
}

function recapRow(key: string, card: string): TranscriptRow {
  return {
    key,
    role: "custom",
    blocks: [{ kind: "text", text: card }],
    copyText: card,
    customType: "pixie-segments",
    display: true,
  };
}

function assistantRow(key: string): TranscriptRow {
  return {
    key,
    role: "assistant",
    blocks: [{ kind: "text", text: "ok" }],
    copyText: "ok",
  };
}

describe("parsePixieSegmentsRecap", () => {
  it("splits intro, segment list and tail without the wrapper tags", () => {
    const recap = parsePixieSegmentsRecap(RECAP);
    expect(recap.entries).toEqual([
      { index: 0, title: "😀 Qoder反代项目推荐", meta: "10-19 12:47 · 65 条" },
      { index: 1, title: "💬 下午好问候", meta: "10-18 09:22 · 2 条" },
    ]);
    expect(recap.intro).toContain("你在小精灵工作区开启了一个新的会话段");
    expect(recap.intro).not.toContain("最近 2 段");
    expect(recap.tailHeading).toBe("上一段（😀 Qoder反代项目推荐）的收尾：");
    expect(recap.tail).toContain("面板密码是 0.0");
    expect(recap.text).not.toContain("<pixie-segments>");
  });

  it("falls back to the plain text when the plugin format changes", () => {
    const recap = parsePixieSegmentsRecap("<pixie-segments>handoff</pixie-segments>");
    expect(recap.entries).toEqual([]);
    expect(recap.text).toBe("handoff");
  });

  it("lifts a contract embedded in the recap card out of the intro", () => {
    const recap = parsePixieSegmentsRecap(RECAP_WITH_INLINE_CONTEXT);
    expect(recap.rules).toContain("本段开始时间");
    // 契约不再从回顾文案里漏出来（标签与正文都不进 intro / text）。
    expect(recap.intro).not.toContain("pixie-context");
    expect(recap.intro).not.toContain("本段开始时间");
    expect(recap.intro).toContain("你在小精灵工作区开启了一个新的会话段");
    expect(recap.text).not.toContain("<pixie-context>");
    expect(recap.entries).toEqual([
      { index: 0, title: "😀 Qoder反代项目推荐", meta: "10-19 12:47 · 65 条" },
      { index: 1, title: "💬 下午好问候", meta: "10-18 09:22 · 2 条" },
    ]);
    expect(recap.tail).toContain("面板密码是 0.0");
  });

  it("keeps rules empty for a contract-free card", () => {
    expect(parsePixieSegmentsRecap(RECAP).rules).toBe("");
  });
});

describe("buildTranscriptPreamble", () => {
  it("keeps the plain transcript when only the system prompt is present", () => {
    const preamble = buildTranscriptPreamble([
      systemRow("event:0", { preamble: "You are pi" }),
      userRow("user:1", "hi"),
    ]);
    expect(preamble).toBeNull();
  });

  it("merges repeated system prompt entries even without pixie blocks", () => {
    const preamble = buildTranscriptPreamble([
      systemRow("event:0", { preamble: "You are pi", tools: "old tools" }),
      userRow("user:1", "hi"),
      systemRow("event:2", { tools: "new tools" }),
    ]);
    expect([...(preamble?.consumedKeys ?? [])]).toEqual(["event:0", "event:2"]);
    expect(preamble?.model.systemPrompt).toMatchObject({
      sections: { preamble: "You are pi", tools: "new tools" },
    });
  });

  it("folds system prompt, pixie context and the segment recap into one card", () => {
    const preamble = buildTranscriptPreamble([
      systemRow("event:0", { preamble: "You are pi", tools: "old tools" }),
      systemRow("event:3", { tools: "new tools", rules: "rules" }),
      userRow("user:1", `[pixie|ui]\n${PIXIE_CONTEXT}\n嗨`),
      recapRow("custom:2", RECAP),
      assistantRow("assistant:4"),
    ]);
    expect(preamble).not.toBeNull();
    expect(preamble?.contextRowKey).toBe("user:1");
    expect([...(preamble?.consumedKeys ?? [])]).toEqual(["event:0", "event:3", "custom:2"]);
    // 多次落盘是增量：小节按 last-wins 合并成"当前生效"的提示词。
    expect(preamble?.model.systemPrompt).toMatchObject({
      sections: { preamble: "You are pi", tools: "new tools", rules: "rules" },
    });
    expect(preamble?.model.rules).toContain("本段开始时间");
    expect(preamble?.model.recap?.entries[0]?.title).toBe("😀 Qoder反代项目推荐");
  });

  it("folds an embedded contract from the card into rules for new segments", () => {
    // 新形态：首条用户消息没有包装（Host 已不再注入），契约内嵌在卡片里。
    const preamble = buildTranscriptPreamble([
      systemRow("event:0", { preamble: "You are pi" }),
      userRow("user:1", "嗨"),
      recapRow("custom:2", RECAP_WITH_INLINE_CONTEXT),
      assistantRow("assistant:3"),
    ]);
    expect(preamble?.model.rules).toContain("本段开始时间");
    expect(preamble?.model.rules).not.toContain("<pixie-context>");
    expect(preamble?.model.recap?.intro).not.toContain("本段开始时间");
    expect(preamble?.model.recap?.entries).toHaveLength(2);
  });

  it("leaves a recap that appears mid-conversation in the message flow", () => {
    const preamble = buildTranscriptPreamble([
      systemRow("event:0", { preamble: "You are pi" }),
      userRow("user:1", `[pixie|ui]\n${PIXIE_CONTEXT}\n嗨`),
      assistantRow("assistant:2"),
      recapRow("custom:3", RECAP),
    ]);
    expect(preamble?.consumedKeys.has("custom:3")).toBe(false);
    expect([...(preamble?.consumedKeys ?? [])]).toEqual(["event:0"]);
    expect(preamble?.model.recap).toBeUndefined();
  });
});
