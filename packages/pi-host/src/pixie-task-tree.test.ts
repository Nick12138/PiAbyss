/**
 * 任务树投影（pixie.taskTree 的数据形状）：分组、短名与会话名兜底、四态收敛，
 * 以及展示档位的排序。跳转按会话给（面板自己用 cwd + sessionId 拼），投影里
 * 不再有消息锚点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failDispatch,
  registerDispatch,
  resetPixieStateForTests,
  settleDispatch,
  clipPixieShortName,
  pixieFallbackName,
} from "./pixie-agent-runner.js";
import { buildPixieTaskTree, pixieTaskStatusOf, pixieWorkspaceLabel } from "./pixie-task-tree.js";

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

  it("任务排序：进行中 → 失败 → 排队（先派发的在上）→ 已完成", () => {
    const agentDir = freshAgentDir();
    const base = Date.now();
    const backdate = (record: { createdAt: number }, minutesAgo: number): void => {
      record.createdAt = base - minutesAgo * 60_000;
    };
    const late = addTask(agentDir, {
      task: "改文案",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "改文案",
      status: "queued",
    });
    backdate(late, 1);
    const first = addTask(agentDir, {
      task: "整理周报",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "整理周报",
      status: "queued",
    });
    backdate(first, 3);
    const running = addTask(agentDir, {
      task: "跑登录测试",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "跑登录测试",
    });
    backdate(running, 8);
    const done = addTask(agentDir, {
      task: "查 git 近况",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "查 git 近况",
    });
    backdate(done, 18);
    settleDispatch(done.id, "完成了", "done", agentDir);
    const broken = addTask(agentDir, {
      task: "挂了的那条",
      cwd: "C:/work/PiAbyss",
      sessionId: "s-a",
      taskName: "挂了的那条",
    });
    backdate(broken, 40);
    failDispatch(broken.id, "boom", agentDir);

    const [group] = buildPixieTaskTree(agentDir, "seg-1");
    expect(group!.sessions[0]!.tasks.map((task) => [task.label, task.status])).toEqual([
      ["跑登录测试", "running"],
      ["挂了的那条", "failed"],
      ["整理周报", "queued"],
      ["改文案", "queued"],
      ["查 git 近况", "done"],
    ]);
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

    const mine = buildPixieTaskTree(agentDir, "seg-1");
    const all = mine.flatMap((group) => group.sessions.flatMap((session) => session.tasks));
    expect(all.map((task) => task.label).sort()).toEqual(["本段的历史", "还在跑"].sort());
    // 换到别的段：终态的「本段的历史」不再出现，跨段仍在跑的「还在跑」必须还在。
    const other = buildPixieTaskTree(agentDir, "seg-2");
    const otherTasks = other.flatMap((group) => group.sessions.flatMap((session) => session.tasks));
    expect(otherTasks.map((task) => task.label)).toEqual(["还在跑"]);
  });
});
