/**
 * 任务树投影（pixie.taskTree 的数据形状）：分组、短名与会话名兜底、四态收敛，
 * 以及跳转锚点的优先级——结果回执落在小精灵段会话，派发消息落在被委派会话，
 * 老记录两个都没有时只带会话坐标（前端据此打开会话但不滚动）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerDispatch,
  resetPixieStateForTests,
  resolvePixieWorkspacePath,
  setDispatchMessageAnchor,
  settleDispatch,
  clipPixieShortName,
  pixieFallbackName,
} from "./pixie-agent-runner.js";
import { buildPixieTaskTree, pixieTaskStatusOf, pixieWorkspaceLabel } from "./pixie-task-tree.js";
import { upsertPixieSession } from "./pixie-session-cache.js";

let currentDir: string | null = null;

function freshAgentDir(): string {
  resetPixieStateForTests();
  if (currentDir) rmSync(currentDir, { recursive: true, force: true });
  currentDir = mkdtempSync(join(tmpdir(), "pixie-tree-"));
  return currentDir;
}

afterEach(() => {
  resetPixieStateForTests();
  delete process.env.PIABYSS_PIXIE_WORKSPACE;
});

function addTask(
  agentDir: string,
  input: {
    task: string;
    cwd: string;
    sessionId: string;
    taskName?: string | null;
    sessionName?: string | null;
    originSessionId?: string | null;
    status?: "dispatched" | "queued";
  },
) {
  return registerDispatch({
    cwd: input.cwd,
    sessionId: input.sessionId,
    sessionPath: `${input.sessionId}.jsonl`,
    task: input.task,
    agentDir,
    taskName: input.taskName ?? null,
    sessionName: input.sessionName ?? null,
    originSessionId: input.originSessionId ?? "seg-1",
    queued: input.status === "queued",
  });
}

describe("短名口径", () => {
  it("按码位裁到 20 字，CJK 一个字算一个", () => {
    const cjk = "一二三四五六七八九十一二三四五六七八九十一二三";
    expect(Array.from(clipPixieShortName(cjk)).length).toBe(20);
    expect(clipPixieShortName("  修复 登录\n测试  ")).toBe("修复 登录 测试");
    expect(pixieFallbackName("把登录相关的测试全部跑一遍并把失败项逐个修好")).toBe(
      "把登录相关的测试全部跑一遍并把失败项逐个",
    );
  });

  it("表情符号不被拆坏", () => {
    expect(clipPixieShortName("👨‍👩‍👧 家庭任务")).toBe("👨‍👩‍👧 家庭任务");
  });
});

describe("四态收敛", () => {
  it("按 Host 状态映射成排队/进行中/已完成/失败", () => {
    expect(pixieTaskStatusOf("queued")).toBe("queued");
    expect(pixieTaskStatusOf("dispatched")).toBe("running");
    expect(pixieTaskStatusOf("paused")).toBe("running");
    expect(pixieTaskStatusOf("awaiting_user")).toBe("running");
    expect(pixieTaskStatusOf("reported")).toBe("done");
    expect(pixieTaskStatusOf("failed")).toBe("failed");
    expect(pixieTaskStatusOf("stopped")).toBe("failed");
    expect(pixieTaskStatusOf("cancelled")).toBe("failed");
  });

  it("工作区标签取路径最后一段", () => {
    expect(pixieWorkspaceLabel("C:\\Users\\liu\\Documents\\我的项目\\PiAbyss")).toBe("PiAbyss");
    expect(pixieWorkspaceLabel("/home/me/wps/")).toBe("wps");
  });
});

describe("任务树分组", () => {
  it("工作区 → 会话 → 任务，任务用 taskName，会话用 sessionName", () => {
    const agentDir = freshAgentDir();
    addTask(agentDir, {
      task: "把登录相关的测试全部跑一遍并把失败项逐个修好",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "跑登录测试",
      sessionName: "登录修复",
    });
    addTask(agentDir, {
      task: "整理本周周报草稿",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "整理周报",
    });
    addTask(agentDir, {
      task: "打包发布",
      cwd: "D:/other/WPS",
      sessionId: "s-b",
      sessionName: "发布通道",
    });

    const groups = buildPixieTaskTree(agentDir, "seg-1");
    // 排序：最近有活动的先出现（WPS 那条最后登记）。
    expect(groups.map((group) => group.workspaceLabel)).toEqual(["WPS", "PiAbyss"]);
    const piabyss = groups.find((group) => group.workspaceLabel === "PiAbyss")!;
    expect(piabyss.cwd).toBe("C:/work/PiAbyss");
    expect(piabyss.sessions).toHaveLength(1);
    expect(piabyss.sessions[0]!.label).toBe("登录修复");
    expect(piabyss.sessions[0]!.tasks.map((task) => task.label)).toEqual([
      "整理周报",
      "跑登录测试",
    ]);
    expect(groups[0]!.sessions[0]!.label).toBe("发布通道");
  });

  it("旧版插件没传短名：任务用 task 前缀兜底，会话不显示「新会话」", () => {
    const agentDir = freshAgentDir();
    const record = addTask(agentDir, {
      task: "排查移动端页面在 Safari 下白屏的根因并给出修复方案",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
    });
    const [group] = buildPixieTaskTree(agentDir, "seg-1");
    const task = group!.sessions[0]!.tasks[0]!;
    expect(task.label).toBe(pixieFallbackName(record.task));
    expect(group!.sessions[0]!.label).toBe(pixieFallbackName(record.task));
    expect(group!.sessions[0]!.label).not.toBe("新会话");
  });

  it("活跃记录跨段也进树；终态记录按归属段过滤", () => {
    const agentDir = freshAgentDir();
    addTask(agentDir, {
      task: "还在跑",
      cwd: "C:/work/a",
      sessionId: "s-a",
      originSessionId: "seg-old",
    });
    const done = addTask(agentDir, {
      task: "本段的历史",
      cwd: "C:/work/a",
      sessionId: "s-b",
      originSessionId: "seg-1",
    });
    settleDispatch(done.id, "完成了", "done", agentDir);
    setDispatchMessageAnchor(done.id, agentDir, { dispatchMessageId: "entry-x" });

    const mine = buildPixieTaskTree(agentDir, "seg-1");
    const all = mine.flatMap((group) => group.sessions.flatMap((session) => session.tasks));
    expect(all.map((task) => task.label).sort()).toEqual(["本段的历史", "还在跑"].sort());
    // 换到别的段：终态的「本段的历史」不再出现，跨段仍在跑的「还在跑」必须还在。
    const other = buildPixieTaskTree(agentDir, "seg-2");
    const otherTasks = other.flatMap((group) => group.sessions.flatMap((session) => session.tasks));
    expect(otherTasks.map((task) => task.label)).toEqual(["还在跑"]);
  });
});

describe("跳转锚点", () => {
  it("有结果回执时跳到小精灵段会话那条消息", () => {
    const agentDir = freshAgentDir();
    const record = addTask(agentDir, {
      task: "跑测试",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "跑测试",
    });
    setDispatchMessageAnchor(record.id, agentDir, {
      dispatchMessageId: "entry-dispatch",
      reportMessageId: "entry-report",
    });
    const pixieCwd = resolvePixieWorkspacePath(agentDir);
    upsertPixieSession(agentDir, {
      sessionId: "seg-1",
      sessionPath: join(pixieCwd, "sessions", "seg-1.jsonl"),
      cwd: pixieCwd,
      owner: "pixie",
      role: "pixie",
    });

    const task = buildPixieTaskTree(agentDir, "seg-1")[0]!.sessions[0]!.tasks[0]!;
    expect(task.jump).toMatchObject({
      cwd: pixieCwd,
      sessionId: "seg-1",
      messageId: "entry-report",
      anchor: "report",
    });
    expect(task.dispatchMessageId).toBe("entry-dispatch");
    expect(task.reportMessageId).toBe("entry-report");
  });

  it("只有派发消息时跳到被委派会话；两个都没有时只带会话坐标", () => {
    const agentDir = freshAgentDir();
    const withDispatch = addTask(agentDir, {
      task: "任务甲",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
    });
    setDispatchMessageAnchor(withDispatch.id, agentDir, { dispatchMessageId: "entry-1" });
    addTask(agentDir, { task: "任务乙", cwd: "C:/work/PiAbyss", sessionId: "s-b" });

    const tasks = buildPixieTaskTree(agentDir, "seg-1")[0]!
      .sessions.flatMap((session) => session.tasks)
      .sort((left, right) => left.label.localeCompare(right.label));
    expect(tasks[0]!.jump).toMatchObject({
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      messageId: "entry-1",
      anchor: "dispatch",
    });
    // 老记录（没有锚点）：会话坐标齐全、messageId=null，前端点击只打开不滚动。
    expect(tasks[1]!.jump).toMatchObject({ sessionId: "s-b", messageId: null, anchor: null });
  });
});
