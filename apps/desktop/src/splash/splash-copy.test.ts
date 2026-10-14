import { describe, expect, it } from "vitest";
import {
  NARRATIVE,
  NARRATIVE_FADE_MS,
  NARRATIVE_INTERVAL_MS,
  STAGE_RANK,
  isSplashStage,
  shuffled,
  type SplashStage,
} from "./splash-copy";

const STAGES = Object.keys(STAGE_RANK) as SplashStage[];
const LOCALES = ["zh", "en"] as const;

describe("splash stage vocabulary", () => {
  it("ranks every stage strictly forward, in declaration order", () => {
    // 顺序本身就是契约：splash 靠它挡住「主窗口刚挂载时算出的旧阶段」。
    expect(STAGES).toEqual([
      "preparing",
      "starting-host",
      "restoring-workspace",
      "restoring-session",
      "reconnecting",
      "ready",
    ]);
    STAGES.forEach((stage, index) => {
      expect(STAGE_RANK[stage]).toBe(index);
    });
  });

  it("recognizes only known stages", () => {
    for (const stage of STAGES) expect(isSplashStage(stage)).toBe(true);
    for (const junk of [undefined, null, "", "ready ", "READY", 0, {}]) {
      expect(isSplashStage(junk)).toBe(false);
    }
  });
});

describe("narrative copy", () => {
  it("keeps both locales the same length and free of duplicates", () => {
    // 两个语种长度必须一致：语言是异步补上的，长度不等会让轮播索引越界后
    // 落到 undefined 上（SplashApp 的 `lines[lineIndex] ?? ""` 兜的是这个）。
    expect(NARRATIVE.zh.length).toBe(NARRATIVE.en.length);
    for (const locale of LOCALES) {
      const lines = NARRATIVE[locale];
      expect(lines.length).toBeGreaterThanOrEqual(5);
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) expect(line.trim()).toBeTruthy();
    }
  });

  it("paces the rotation for reading, not for showing off", () => {
    // 3 秒一条：留出读完一句的时间。故意与 Rust 侧 MIN_SPLASH_VISIBLE_MS
    // 相等——多数启动只会看到第一句，轮播是给启动慢的场景准备的。
    // 别为了「秀轮播」把这个值调小。
    expect(NARRATIVE_INTERVAL_MS).toBe(3_000);
    // 淡出必须只占间隔的一小部分，否则一句话大半时间都是透明的。
    expect(NARRATIVE_FADE_MS).toBeLessThan(NARRATIVE_INTERVAL_MS / 3);
  });

  it("never writes the copy around a persona", () => {
    // PiAbyss 没有「她 / Ta」这样的角色设定。文案只允许围绕产品本身写，
    // 一旦出现拟人代词就说明有人把别处的口吻抄进来了。
    // `(?<!其)他` 放过「其他」这类普通词，只拦真正当人称用的「他」。
    for (const line of NARRATIVE.zh) {
      expect(line).not.toMatch(/(?<!其)他|她|\bTa\b|小精灵/);
    }
    for (const line of NARRATIVE.en) {
      expect(line).not.toMatch(/\b(she|he|her|hers|herself|him|himself)\b/i);
    }
  });
});

describe("shuffled", () => {
  it("returns a permutation without mutating the input", () => {
    const source = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
    const frozen = [...source];
    const result = shuffled(source);
    expect([...source]).toEqual(frozen);
    expect(result).not.toBe(source);
    expect([...result].sort()).toEqual([...source].sort());
  });
});
