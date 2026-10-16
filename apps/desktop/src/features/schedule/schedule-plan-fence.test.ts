/**
 * `schedule-plan` 围栏的拆分测试。
 *
 * 这是草案进对话的唯一入口：拆错了要么卡片点不出来（用户看不到确认），
 * 要么把模型说的话吞掉一半。所以边界用例（未闭合、坏 JSON、多份、非围栏文本）
 * 都在这里钉住。
 */
import { describe, expect, it } from "vitest";
import {
  extractPlanFences,
  hasPlanFence,
  latestPlanFence,
  splitPlanFenceSegments,
  stripPlanFences,
} from "./schedule-plan-fence";

const FENCE = (json: string) => "说明在前。\n```schedule-plan\n" + json + "\n```\n说明在后。";
const DRAFT = JSON.stringify({ name: "日报", cwd: "D:/p", trigger: { type: "manual" } });

describe("extractPlanFences", () => {
  it("按出现顺序取出多份完整草案", () => {
    const text = `${FENCE(DRAFT)}\n再改一版：\n${FENCE(DRAFT)}`;
    const fences = extractPlanFences(text);
    expect(fences).toHaveLength(2);
    expect(fences[0].plan?.name).toBe("日报");
  });

  it("坏 JSON 返回 plan:null 但保留原文（不能静默吞掉）", () => {
    const [fence] = extractPlanFences(FENCE("{ not json"));
    expect(fence.plan).toBeNull();
    expect(fence.raw).toBe("{ not json");
  });

  it("未闭合的围栏不算草案", () => {
    expect(extractPlanFences('开头```schedule-plan\n{"name":')).toEqual([]);
  });

  it("latestPlanFence 取最后一份能解析的", () => {
    const text = `${FENCE(DRAFT)}\n${FENCE("{ broken")}`;
    expect(latestPlanFence(text)?.name).toBe("日报");
  });
});

describe("splitPlanFenceSegments / stripPlanFences", () => {
  it("保留围栏前后的话，中间换成草案", () => {
    const parts = splitPlanFenceSegments(FENCE(DRAFT));
    expect(parts.map((part) => part.kind)).toEqual(["text", "plan", "text"]);
  });

  it("没有围栏时原样返回（同引用，别白拆一遍）", () => {
    const text = "普通一句话";
    expect(splitPlanFenceSegments(text)).toEqual([{ kind: "text", text }]);
    expect(stripPlanFences(text)).toBe(text);
  });

  it("剥掉完整围栏并剪掉未闭合的尾巴（两段话之间留一个空行，同旧口径）", () => {
    expect(stripPlanFences(FENCE(DRAFT))).toBe("说明在前。\n\n说明在后。");
    expect(stripPlanFences('前半句```schedule-plan\n{"na')).toBe("前半句");
  });

  it("hasPlanFence 认流式中的半截围栏（投影要据此改渲染）", () => {
    expect(hasPlanFence("x ```schedule-plan\n{")).toBe(true);
    expect(hasPlanFence("x ```json\n{}```")).toBe(false);
  });
});
