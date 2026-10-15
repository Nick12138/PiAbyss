import { describe, expect, it } from "vitest";
import {
  buildInjectedReferenceEnvelope,
  joinOutgoingParts,
  parseInjectedReferences,
  stripInjectedReferences,
} from "./injected-references";

const memoBlock = [
  '<piabyss-memo id="note-1" type="memo" status="open" tags="bug">',
  "# 修复登录按钮",
  "",
  "点击没反应。",
  "</piabyss-memo>",
].join("\n");

const pixieBlock = [
  "<pixie-context>",
  "你是小精灵，PiAbyss 桌面里的常驻小助手（人格、语气与工作方式见工作区 CLAUDE.md）。",
  "本段开始时间：2026-10-15（周四）22:00，UTC+8。",
  "已知的 PiAbyss 工作区：",
  "- D:\\我的项目\\PiAbyss",
  "</pixie-context>",
].join("\n");
const pixiePreamble = `[pixie|ui]\n${pixieBlock}`;

describe("buildInjectedReferenceEnvelope", () => {
  it("wraps the payload and escapes quotes in the title", () => {
    const envelope = buildInjectedReferenceEnvelope({
      kind: "memo",
      title: '修 "登录" 按钮',
      body: memoBlock,
    });
    expect(envelope.startsWith('<piabyss-ref kind="memo" title="修 \'登录\' 按钮">')).toBe(true);
    expect(envelope.endsWith("</piabyss-ref>")).toBe(true);
    expect(envelope).toContain(memoBlock);
  });

  it("omits an empty title attribute", () => {
    const envelope = buildInjectedReferenceEnvelope({ kind: "memo", body: memoBlock });
    expect(envelope.startsWith('<piabyss-ref kind="memo">')).toBe(true);
  });
});

describe("parseInjectedReferences", () => {
  it("folds an envelope into one reference and keeps the user's text", () => {
    const raw = `${buildInjectedReferenceEnvelope({
      kind: "memo",
      title: "修复登录按钮",
      body: `${memoBlock}\n\n请处理上面引用的备忘录记录。`,
    })}\n\n顺便看下 session 列表`;

    const parsed = parseInjectedReferences(raw);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.kind).toBe("memo");
    expect(parsed.references[0]?.title).toBe("修复登录按钮");
    expect(parsed.references[0]?.body).toContain("请处理上面引用的备忘录记录。");
    expect(parsed.text).toBe("顺便看下 session 列表");
  });

  it("does not report the memo block nested inside the envelope twice", () => {
    const raw = buildInjectedReferenceEnvelope({ kind: "memo", title: "t", body: memoBlock });
    const parsed = parseInjectedReferences(raw);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.raw.match(/<piabyss-memo /g)).toHaveLength(1);
  });

  it("falls back to the block heading when a bare memo has no envelope title", () => {
    const parsed = parseInjectedReferences(`${memoBlock}\n\n继续处理`);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.title).toBe("修复登录按钮");
    expect(parsed.text).toBe("继续处理");
  });

  it("collects result, preamble and job blocks in order", () => {
    const raw = [
      memoBlock,
      '<piabyss-memo-result noteId="note-1" sessionId="s-1">\n做完了\n</piabyss-memo-result>',
      "<schedule-preamble>\n你是助手。\n</schedule-preamble>",
      '<schedule-job id="job-1">\n{"name":"备份"}\n</schedule-job>',
      "用户需求：\n每天备份",
    ].join("\n\n");

    const parsed = parseInjectedReferences(raw);
    expect(parsed.references.map((reference) => reference.kind)).toEqual([
      "memo",
      "memo-result",
      "schedule-preamble",
      "schedule-job",
    ]);
    expect(parsed.text).toBe("用户需求：\n每天备份");
  });

  it("leaves ordinary messages untouched", () => {
    const raw = "看一下 <piabyss-memo 但不是块\n\n以及 `piabyss-memo` 这个词";
    const parsed = parseInjectedReferences(raw);
    expect(parsed.references).toEqual([]);
    expect(parsed.text).toBe(raw);
  });

  it("keeps an unknown envelope kind renderable as a memo chip", () => {
    const parsed = parseInjectedReferences(
      '<piabyss-ref kind="mystery" title="t">\nbody\n</piabyss-ref>',
    );
    expect(parsed.references[0]?.kind).toBe("memo");
    expect(parsed.text).toBe("");
  });

  it("strips injected blocks but keeps attachment markers visible", () => {
    const raw = `${memoBlock}\n\n<attached-path name="a.ts" path="/w/a.ts"/>`;
    expect(stripInjectedReferences(raw)).toBe('<attached-path name="a.ts" path="/w/a.ts"/>');
  });

  it("folds the pixie segment preamble into one chip and keeps only the user's words", () => {
    const parsed = parseInjectedReferences(`${pixiePreamble}\n晚上好`);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.kind).toBe("pixie-context");
    expect(parsed.references[0]?.body).toContain("本段开始时间");
    expect(parsed.references[0]?.raw).toBe(pixieBlock);
    expect(parsed.text).toBe("晚上好");
  });

  it("drops the channel marker the delivery path repeats after the preamble", () => {
    const parsed = parseInjectedReferences(`${pixiePreamble}\n[pixie|tg]\n看看这个`);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.text).toBe("看看这个");
  });

  it("hides a bare channel marker with no preamble attached", () => {
    expect(stripInjectedReferences("[pixie|tg]\n看看这个")).toBe("看看这个");
  });

  it("keeps the folded preamble re-sendable so a retry does not lose it", () => {
    const parsed = parseInjectedReferences(`${pixiePreamble}\n晚上好`);
    expect(
      joinOutgoingParts([...parsed.references.map((reference) => reference.raw), parsed.text]),
    ).toBe(`${pixieBlock}\n\n晚上好`);
  });
});

describe("joinOutgoingParts", () => {
  it("drops empty parts and joins with a blank line", () => {
    expect(joinOutgoingParts(["block", "  ", "text", undefined])).toBe("block\n\ntext");
    expect(joinOutgoingParts([])).toBe("");
  });
});
