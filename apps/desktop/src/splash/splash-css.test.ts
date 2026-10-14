/**
 * 进度条几何契约。
 *
 * 存在的理由：`translateX` 的百分比是**相对高亮条自身宽度**的，而要从
 * 「完全在左边界外」走到「完全在右边界外」需要位移 `高亮宽 + 轨道宽`。
 * 这两个数一旦对不上，超出的那截会被 `overflow: hidden` 裁掉，表现为
 * 「进度条扫过去 → 愣一下 → 才重新出现」——而且是纯视觉 bug，类型检查和
 * 逻辑测试全都发现不了。这个文件把关系式钉死。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** CSS 注释里有大量 `translateX(...)` 的示例文字，必须先剥掉再解析。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = stripComments(readFileSync(join(process.cwd(), "src/styles/splash.css"), "utf8"));

const fill = /--splash-bar-fill:\s*([\d.]+)%/.exec(css);
const keyframes = /@keyframes splash-sweep \{([\s\S]*?)\}/.exec(css);
const from = /from\s*\{[^}]*translateX\((-?[\d.]+)%\)/.exec(css);
const to = /to\s*\{[^}]*translateX\((-?[\d.]+)%\)/.exec(css);

describe("splash sweep geometry", () => {
  it("parses the bar fill width and the sweep keyframes", () => {
    // 结构变了（改名/删块）时先在这里失败，别让下面的断言拿到 null 报难懂的错。
    expect(fill?.[1]).toBeTruthy();
    expect(keyframes?.[1]).toBeTruthy();
    expect(from?.[1]).toBeTruthy();
    expect(to?.[1]).toBeTruthy();
  });

  it("starts the highlight exactly off the left edge", () => {
    // -100%（自身宽度）= 右缘正好贴在左边界上，第一帧不会从空白里冒出来。
    expect(Number(from?.[1])).toBe(-100);
  });

  it("ends the highlight exactly at the right edge", () => {
    // 位移必须刚好等于「高亮宽 + 轨道宽」。
    // translateX 的 % 相对**自身宽度**：高亮宽 w = fill% × 轨道宽 W，
    // 所以 W / w = 100 / fill（无量纲），终点 = (100 / fill) × 100 %。
    // 写大了 → 高亮冲出右边界被裁，周期末段轨道空白（就是那个「愣一下」）；
    // 写小了 → 高亮半途掉头，扫过的距离明显不满轨。
    const fillPercent = Number(fill?.[1]);
    const trackOverFill = 100 / fillPercent;
    const expectedEnd = trackOverFill * 100;
    expect(Math.abs(Number(to?.[1]) - expectedEnd)).toBeLessThan(1);
  });

  it("keeps the sweep continuous — no off-track gap in the cycle", () => {
    // 上面一条的推论，单独断言一遍是为了让失败信息直指现象：
    // 高亮在轨道内可见的行程必须铺满整个动画周期。
    const fillPercent = Number(fill?.[1]);
    const start = Number(from?.[1]);
    const end = Number(to?.[1]);
    const leftEdgeAtTrackEnd = (100 / fillPercent) * 100;
    const visibleUntil = (leftEdgeAtTrackEnd - start) / (end - start);
    expect(visibleUntil).toBeGreaterThan(0.99);
  });

  it("animates forever, so a slow Host never freezes the bar", () => {
    expect(css).toMatch(/animation:\s*splash-sweep\s+[\d.]+ms\s+[^;]*\binfinite\b/);
  });
});
