import { describe, expect, it } from "vitest";
import { pixieCallbackSummary } from "./pixie-callbacks";

describe("pixieCallbackSummary", () => {
  it("shows the question line for an ask envelope", () => {
    const body = [
      "被委派会话（目标 cwd：/w）需要用户决策，已暂停等待答复：",
      "问题：用哪个分支发布？",
      "可选项：",
      "- main",
      "请立即把问题转述给用户（不要代答）。",
    ].join("\n");
    expect(pixieCallbackSummary(body, "ask")).toBe("用哪个分支发布？");
  });

  it("shows the underlying error instead of the failure header", () => {
    const body = [
      "委派任务执行失败（目标 cwd：/w，第 2 次失败）：",
      "错误类型：aborted",
      "原始错误：Request was aborted",
      "请按会话状态决策：可续跑→原地续跑。",
    ].join("\n");
    expect(pixieCallbackSummary(body, "error")).toBe("Request was aborted");
  });

  it("skips the boilerplate first line of progress and report envelopes", () => {
    const progress = [
      "被委派会话（目标 cwd：/w）的进度汇报：",
      "已经跑通构建，正在跑测试。",
      "请把进度转述给用户（轻量即可，不必展开）。",
    ].join("\n");
    expect(pixieCallbackSummary(progress, "progress")).toBe("已经跑通构建，正在跑测试。");
    const report = [
      "被委派会话已回调（目标 cwd：/w）：",
      "完成：配置已改好。",
      "请把上述结果整理后转述给用户。",
    ].join("\n");
    expect(pixieCallbackSummary(report, "report")).toBe("完成：配置已改好。");
  });

  it("falls back to the first line and caps the length", () => {
    expect(pixieCallbackSummary("\n\n第一行\n第二行", "stopped")).toBe("第一行");
    expect(pixieCallbackSummary("长".repeat(200), undefined)).toHaveLength(121);
  });

  it("shows the task / reply text instead of the lead-in line", () => {
    const dispatch = [
      "这条任务来自「小精灵」（pixie）。请按以下要求执行：",
      "把 8790 看板的密码改成 0.0",
      "完成（或确认无法完成）后，必须调用 pixie_report 工具回调：",
    ].join("\n");
    expect(pixieCallbackSummary(dispatch, "dispatch")).toBe("把 8790 看板的密码改成 0.0");
    const reply = ["用户对上述问题的答复：", "用 main 分支", "请基于该答复继续执行。"].join("\n");
    expect(pixieCallbackSummary(reply, "reply")).toBe("用 main 分支");
  });
});
