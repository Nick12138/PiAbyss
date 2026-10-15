import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askDispatch,
  clipPixieShortName,
  ensurePixiePersonaFile,
  failDispatch,
  findDispatchById,
  findDispatchBySession,
  findDuplicateDispatchRequest,
  hasActiveDispatchFor,
  listDispatches,
  listDispatchesForPanel,
  parsePixieModelRef,
  pixieClockLine,
  pixieDir,
  pixieFallbackName,
  reactivateDispatchAfterReply,
  registerDispatch,
  resetPixieStateForTests,
  resolvePixieWorkspacePath,
  settleDispatch,
  setDispatchMessageAnchor,
  pixieStaleMs,
  pixieSegmentMaxTurns,
  pixieTranscriptFrom,
  segmentSessionName,
  setPixieContext,
  getKnownWorkspaces,
} from "./pixie-agent-runner.js";
import {
  buildDispatchTaskPrompt,
  createPixieControlPlaneDeps,
  type PixieDispatchRequest,
} from "./pixie-controller.js";
import { buildPromptWithAttachments, toSdkImages } from "./agent-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { localDayKey } from "./pixie-usage.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshAgentDir(): string {
  resetPixieStateForTests();
  return mkdtempSync(join(tmpdir(), "pixie-test-"));
}

afterEach(() => {
  resetPixieStateForTests();
  delete process.env.PIABYSS_PIXIE_WORKSPACE;
  delete process.env.PIABYSS_PIXIE_STALE_MS;
  delete process.env.PIABYSS_PIXIE_MAX_TURNS;
});

describe("pixie delegation registry", () => {
  it("registers a dispatch and settles it on report", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      task: "check bot",
      agentDir,
    });
    expect(record.status).toBe("dispatched");
    expect(record.kind).toBeNull();
    expect(hasActiveDispatchFor("s1")).toBe(true);
    expect(findDispatchBySession("s1")?.id).toBe(record.id);

    const settled = settleDispatch(record.id, "all good", "done", agentDir);
    expect(settled?.status).toBe("reported");
    expect(settled?.kind).toBe("done");
    expect(settled?.report).toBe("all good");
    expect(hasActiveDispatchFor("s1")).toBe(false);
  });

  it("fails a dispatch and rejects double-settling", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s2",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    const failed = failDispatch(record.id, "boom", agentDir);
    expect(failed?.status).toBe("failed");
    expect(failed?.kind).toBe("error");
    // Double-settle protection: both mutators reject an already-settled record.
    expect(failDispatch(record.id, "boom", agentDir)).toBeNull();
    expect(settleDispatch(record.id, "late report", "done", agentDir)).toBeNull();
    // Backdate so the stale sweep (triggered by later listDispatches calls) cannot
    // poison the ordering assertion below.
    (record as { createdAt: number }).createdAt = Date.now() - pixieStaleMs() - 60_000;
  });

  it("lists dispatches newest first with a bound", async () => {
    const agentDir = freshAgentDir();
    for (let i = 0; i < 5; i++) {
      const record = registerDispatch({
        cwd: "C:/ws",
        sessionId: `bulk-${i}`,
        sessionPath: null,
        task: `t${i}`,
        agentDir,
      });
      (record as { createdAt: number }).createdAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const all = listDispatches(50, agentDir).filter((d) => d.sessionId?.startsWith("bulk-"));
    expect(all.length).toBe(5);
    for (let i = 1; i < all.length; i++) {
      const previous = all[i - 1]!;
      const current = all[i]!;
      expect(previous.createdAt).toBeGreaterThanOrEqual(current.createdAt);
    }
    expect(listDispatches(2, agentDir)).toHaveLength(2);
  });

  it("panel list: 按当前会话严格归属（本段终态 + 跨段活跃），null 归属不再全段兜底", () => {
    const agentDir = freshAgentDir();
    const base = {
      cwd: "C:/ws",
      sessionPath: null,
      task: "t",
      agentDir,
    };
    // seg-a：一条还在跑（跨段也必须可见）+ 一条已终态（只归 seg-a）。
    const live = registerDispatch({ ...base, sessionId: "t-live", originSessionId: "seg-a" });
    expect(live.originSessionId).toBe("seg-a");
    const segADone = registerDispatch({ ...base, sessionId: "t-a-done", originSessionId: "seg-a" });
    settleDispatch(segADone.id, "ok", "done", agentDir);
    // seg-b：一条已失败（只归 seg-b）。
    const segBFailed = registerDispatch({
      ...base,
      sessionId: "t-b-fail",
      originSessionId: "seg-b",
    });
    failDispatch(segBFailed.id, "boom", agentDir);
    // 旧版无归属记录：推断不出归属就不显示（否则面板退化成混合历史）。
    const legacy = registerDispatch({ ...base, sessionId: "t-legacy" });
    expect(legacy.originSessionId).toBeNull();
    settleDispatch(legacy.id, "old, hidden unless inferred", "done", agentDir);

    const panelForSegB = listDispatchesForPanel(agentDir, "seg-b");
    expect(panelForSegB.map((d) => d.id)).toEqual(expect.arrayContaining([live.id, segBFailed.id]));
    expect(panelForSegB.some((d) => d.id === segADone.id)).toBe(false);
    expect(panelForSegB.some((d) => d.id === legacy.id)).toBe(false);

    const panelForSegA = listDispatchesForPanel(agentDir, "seg-a");
    expect(panelForSegA.map((d) => d.id)).toEqual(expect.arrayContaining([live.id, segADone.id]));
    expect(panelForSegA.some((d) => d.id === segBFailed.id)).toBe(false);
    expect(panelForSegA.some((d) => d.id === legacy.id)).toBe(false);

    // 拿不到会话上下文：只显示活跃委派，宁可少显示也不混入他段历史。
    const panelForNull = listDispatchesForPanel(agentDir, null);
    expect(panelForNull.map((d) => d.id)).toEqual([live.id]);
  });

  it("loadDispatches: 旧记录缺归属时用 v4 timeline.json 段窗口反推", async () => {
    const agentDir = freshAgentDir();
    const pixieDirPath = join(agentDir, "piabyss", "pixie");
    mkdirSync(pixieDirPath, { recursive: true });
    const segAStart = Date.now() - 60_000;
    const segAEnd = Date.now() - 30_000;
    writeFileSync(
      join(pixieDirPath, "timeline.json"),
      JSON.stringify({
        version: 1,
        segments: [
          {
            id: "seg-a",
            sessionId: "session-a",
            sessionPath: "/a.jsonl",
            startedAt: segAStart,
            endedAt: segAEnd,
            separator: null,
            reason: "agent",
            handoff: null,
          },
          {
            id: "seg-b",
            sessionId: "session-b",
            sessionPath: "/b.jsonl",
            startedAt: segAEnd + 1,
            endedAt: null,
            separator: null,
            reason: null,
            handoff: null,
          },
        ],
      }),
      "utf8",
    );
    writeFileSync(
      join(pixieDirPath, "dispatches.json"),
      JSON.stringify({
        version: 1,
        records: [
          {
            id: "pix_old_a",
            status: "reported",
            kind: "done",
            cwd: "C:/ws",
            sessionId: "worker-1",
            sessionPath: null,
            task: "seg-a 时代的任务",
            report: null,
            question: null,
            options: [],
            createdAt: segAStart + 1000,
            startedAt: segAStart + 1000,
            reportedAt: null,
            stale: false,
            staleNotified: false,
            batchId: null,
            failCount: 0,
            progressSummary: null,
            files: null,
            retryOf: null,
            model: null,
            thinkingLevel: null,
          },
          {
            id: "pix_old_b",
            status: "reported",
            kind: "done",
            cwd: "C:/ws",
            sessionId: "worker-2",
            sessionPath: null,
            task: "seg-b 时代的任务",
            report: null,
            question: null,
            options: [],
            createdAt: segAEnd + 5000,
            startedAt: segAEnd + 5000,
            reportedAt: null,
            stale: false,
            staleNotified: false,
            batchId: null,
            failCount: 0,
            progressSummary: null,
            files: null,
            retryOf: null,
            model: null,
            thinkingLevel: null,
          },
        ],
      }),
      "utf8",
    );

    const panelForA = listDispatchesForPanel(agentDir, "session-a");
    expect(panelForA.map((d) => d.id)).toEqual(["pix_old_a"]);
    const panelForB = listDispatchesForPanel(agentDir, "session-b");
    expect(panelForB.map((d) => d.id)).toEqual(["pix_old_b"]);
  });

  it("persists dispatch records across a registry reload", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "persist-1",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    settleDispatch(record.id, "done!", "done", agentDir);
    // Simulate a fresh Host process: wipe memory, reload from disk.
    resetPixieStateForTests();
    const reloaded = listDispatches(50, agentDir).find((d) => d.id === record.id);
    expect(reloaded?.status).toBe("reported");
    expect(reloaded?.report).toBe("done!");
  });

  it("marks stale dispatches after the configured threshold", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s3",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    // v4.1: the stale clock reads lastActiveAt ?? startedAt ?? createdAt.
    const backdated = Date.now() - pixieStaleMs() - 1_000;
    const mutable = record as unknown as {
      createdAt: number;
      startedAt: number | null;
      lastActiveAt: number | null;
    };
    mutable.createdAt = backdated;
    mutable.startedAt = backdated;
    mutable.lastActiveAt = backdated;
    const stale = listDispatches(50, agentDir).find((d) => d.id === record.id);
    expect(stale?.stale).toBe(true);
  });

  it("routes ask → awaiting_user → user reply → dispatched", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "ask-1",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    const asked = askDispatch(record.id, "选哪个方案？", ["方案 A", "方案 B"], agentDir);
    expect(asked?.status).toBe("awaiting_user");
    expect(asked?.kind).toBe("ask");
    expect(asked?.question).toBe("选哪个方案？");
    expect(asked?.options).toEqual(["方案 A", "方案 B"]);

    const reply = reactivateDispatchAfterReply(record.id, "方案 A", agentDir);
    expect("record" in reply && reply.record.status).toBe("dispatched");

    // Reply on a non-awaiting record fails.
    expect("error" in reactivateDispatchAfterReply(record.id, "again", agentDir)).toBe(true);
  });
});

describe("pixie dispatch 重复提交防护", () => {
  it("findDuplicateDispatchRequest：同 cwd + 逐字相同 task 的活跃记录才命中", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "D:/ws",
      sessionId: "dup-1",
      sessionPath: null,
      task: "列出顶层目录",
      agentDir,
    });
    expect(
      findDuplicateDispatchRequest({
        agentDir,
        cwd: "D:/ws",
        task: "列出顶层目录",
        withinMs: 30_000,
      })?.id,
    ).toBe(record.id);
    // 任务文本改一个字 = 新任务，不去重。
    expect(
      findDuplicateDispatchRequest({
        agentDir,
        cwd: "D:/ws",
        task: "列出顶层文件",
        withinMs: 30_000,
      }),
    ).toBeNull();
    // 别的会话（cwd 不同）不去重。
    expect(
      findDuplicateDispatchRequest({
        agentDir,
        cwd: "D:/other",
        task: "列出顶层目录",
        withinMs: 30_000,
      }),
    ).toBeNull();
    // 出了窗口不去重。
    expect(
      findDuplicateDispatchRequest({
        agentDir,
        cwd: "D:/ws",
        task: "列出顶层目录",
        withinMs: 30_000,
        now: record.createdAt + 31_000,
      }),
    ).toBeNull();
    // 已到终态（失败/回调完成）的记录不再充当去重依据。
    failDispatch(record.id, "boom", agentDir);
    expect(
      findDuplicateDispatchRequest({
        agentDir,
        cwd: "D:/ws",
        task: "列出顶层目录",
        withinMs: 30_000,
      }),
    ).toBeNull();
  });

  it("受理已落记录后的原样重试 → 回原 dispatchId，不再开第二个会话", async () => {
    const agentDir = freshAgentDir();
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: () => null,
    } as unknown as WorkspaceGraphFactory;
    const record = registerDispatch({
      cwd: "D:/ws",
      sessionId: "dup-2",
      sessionPath: "D:/s.jsonl",
      task: "列出顶层目录",
      agentDir,
    });

    const outcome = await createPixieControlPlaneDeps(factory).dispatch({
      cwd: "D:/ws",
      task: "列出顶层目录",
      newSession: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.dispatchId).toBe(record.id);
    expect(outcome.queued).toBe(true);
    expect(outcome.queuedNote).toContain("本次没有重复派发");
  });

  it("上一条还在受理中收到同样的请求 → 明确拒绝，不重复执行", async () => {
    const agentDir = freshAgentDir();
    const workspace = freshAgentDir();
    setPixieContext(agentDir, [workspace]);
    let release: (value: { error: Error }) => void = () => undefined;
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: () => null,
      ensureBackgroundGraph: () => new Promise((resolve) => (release = resolve)),
    } as unknown as WorkspaceGraphFactory;
    const dispatch = createPixieControlPlaneDeps(factory).dispatch;

    const pending = dispatch({ cwd: workspace, task: "慢一点的委派" });
    const resubmit = await dispatch({ cwd: workspace, task: "慢一点的委派" });
    expect(resubmit.ok).toBe(false);
    if (resubmit.ok) return;
    expect(resubmit.error).toContain("正在受理中");

    release({ error: new Error("测试：后台打开失败") });
    const first = await pending;
    expect(first.ok).toBe(false);
  });

  it("redispatch（retryOf）是有意重跑，不受去重约束", async () => {
    const agentDir = freshAgentDir();
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: () => null,
    } as unknown as WorkspaceGraphFactory;
    const record = registerDispatch({
      cwd: "D:/ws",
      sessionId: "dup-3",
      sessionPath: null,
      task: "重跑一次",
      agentDir,
    });
    // retryOf 只由 Host 内部的重派路径填写，环回契约传不进来。
    const request: PixieDispatchRequest = {
      cwd: "D:/ws",
      task: "重跑一次",
      retryOf: record.id,
    };
    const outcome = await createPixieControlPlaneDeps(factory).dispatch(request);
    // 走到受理本体才会报「工作区未打开」，说明两道去重都被跳过。
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("目标工作区未打开");
  });
});

describe("pixie 时间锚点（新会话段前导）", () => {
  it("写明日期、周几、时刻与时区，并提示跨天要重新校准", () => {
    const line = pixieClockLine(new Date(2026, 9, 15, 9, 24));
    expect(line).toContain("2026-10-15");
    expect(line).toContain("周四");
    expect(line).toContain("09:24");
    expect(line).toContain("UTC");
    expect(line).toContain("date");
  });
});

describe("pixie workspace + config resolution", () => {
  it("defaults the workspace to <agentDir>/workspace/pixie", () => {
    delete process.env.PIABYSS_PIXIE_WORKSPACE;
    expect(resolvePixieWorkspacePath("C:/agent")).toBe(join("C:/agent", "workspace", "pixie"));
  });

  it("honours PIABYSS_PIXIE_WORKSPACE with the {agentDir} placeholder", () => {
    process.env.PIABYSS_PIXIE_WORKSPACE = "{agentDir}/custom/pixie";
    expect(resolvePixieWorkspacePath("C:/agent")).toBe(join("C:/agent", "custom", "pixie"));
    process.env.PIABYSS_PIXIE_WORKSPACE = "D:/fixed/path";
    expect(resolvePixieWorkspacePath("C:/agent")).toBe(join("D:/fixed/path"));
  });

  it("parses provider/model refs at the first slash", () => {
    expect(parsePixieModelRef("openai/gpt-4o")).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(parsePixieModelRef("openai/gpt-4o/mini")).toEqual({
      provider: "openai",
      id: "gpt-4o/mini",
    });
    expect(parsePixieModelRef("/nope")).toBeNull();
    expect(parsePixieModelRef(undefined)).toBeNull();
  });

  it("applies stale/max-turns env overrides with safe defaults", () => {
    delete process.env.PIABYSS_PIXIE_STALE_MS;
    delete process.env.PIABYSS_PIXIE_MAX_TURNS;
    expect(pixieStaleMs()).toBe(30 * 60 * 1000);
    expect(pixieSegmentMaxTurns()).toBe(200);
    process.env.PIABYSS_PIXIE_STALE_MS = "60000";
    process.env.PIABYSS_PIXIE_MAX_TURNS = "50";
    expect(pixieStaleMs()).toBe(60000);
    expect(pixieSegmentMaxTurns()).toBe(50);
  });

  it("persists and reloads the known-workspace context", () => {
    const agentDir = freshAgentDir();
    setPixieContext(agentDir, ["C:/work/a", "C:/work/b"]);
    resetPixieStateForTests();
    expect(getKnownWorkspaces(agentDir)).toEqual(["C:/work/a", "C:/work/b"]);
  });
});

describe("dispatch task prompt template", () => {
  it("embeds the task and the callback contract", () => {
    const prompt = buildDispatchTaskPrompt({ task: "check okxbot", from: "小精灵委派" });
    expect(prompt).toContain("check okxbot");
    expect(prompt).toContain("pixie_report");
    expect(prompt).toContain("pixie_ask");
    expect(prompt).toContain("piabyss_memo complete");
    expect(prompt).toContain("<pixie-dispatch>");
  });

  it("states manual-user-message priority and the no-complete-while-awaiting-user rule", () => {
    const prompt = buildDispatchTaskPrompt({ task: "t", from: "小精灵委派" });
    expect(prompt).toContain("优先级最高");
    expect(prompt).toContain("以用户指令为准");
    expect(prompt).toContain("不再等待用户输入");
    expect(prompt).toContain("需要用户决策");
  });
});

describe("pixie transcript from disk", () => {
  it("reads messages from a standard session JSONL", () => {
    const agentDir = freshAgentDir();
    const file = join(agentDir, "session_t1.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "t1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
      "utf8",
    );
    const messages = pixieTranscriptFrom(file);
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("hello");
    expect(pixieTranscriptFrom(join(agentDir, "missing.jsonl"))).toEqual([]);
  });
});

describe("pixie usage day key", () => {
  it("formats a local YYYY-MM-DD key", () => {
    const key = localDayKey(new Date(2026, 8, 29, 9, 30).getTime());
    expect(key).toBe("2026-09-29");
  });
});

describe("pixie persona file bootstrap", () => {
  const personaPath = (agentDir: string) => join(resolvePixieWorkspacePath(agentDir), "CLAUDE.md");

  it("首次创建时写入默认人格（含身份与指挥台指引）", () => {
    const agentDir = freshAgentDir();
    ensurePixiePersonaFile(agentDir, resolvePixieWorkspacePath(agentDir));
    const path = personaPath(agentDir);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("你是小精灵");
    expect(text).toContain("指挥台怎么用");
  });

  it("用户手改过之后不再覆盖", () => {
    const agentDir = freshAgentDir();
    const pixieCwd = resolvePixieWorkspacePath(agentDir);
    mkdirSync(pixieCwd, { recursive: true });
    writeFileSync(join(pixieCwd, "CLAUDE.md"), "我自己写的人格", "utf8");
    ensurePixiePersonaFile(agentDir, pixieCwd);
    expect(readFileSync(join(pixieCwd, "CLAUDE.md"), "utf8")).toBe("我自己写的人格");
  });

  it("工作区已有别的上下文文件（AGENTS.md）时不插手", () => {
    const agentDir = freshAgentDir();
    const pixieCwd = resolvePixieWorkspacePath(agentDir);
    mkdirSync(pixieCwd, { recursive: true });
    writeFileSync(join(pixieCwd, "AGENTS.md"), "既有约定", "utf8");
    ensurePixiePersonaFile(agentDir, pixieCwd);
    expect(existsSync(join(pixieCwd, "CLAUDE.md"))).toBe(false);
  });

  it("删掉后不会被恢复（只引导一次）", () => {
    const agentDir = freshAgentDir();
    const pixieCwd = resolvePixieWorkspacePath(agentDir);
    ensurePixiePersonaFile(agentDir, pixieCwd);
    rmSync(personaPath(agentDir));
    ensurePixiePersonaFile(agentDir, pixieCwd);
    expect(existsSync(personaPath(agentDir))).toBe(false);
  });
});

describe("agent prompt attachments（与 agent.prompt 共用）", () => {
  it("toSdkImages 把协议图片映射成 SDK ImageContent", () => {
    expect(toSdkImages([{ mediaType: "image/png", data: "aGk=" }])).toEqual([
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
    expect(toSdkImages([])).toBeUndefined();
    expect(toSdkImages(undefined)).toBeUndefined();
  });

  it("buildPromptWithAttachments 把 attachmentIds 解析成引用块", async () => {
    const factory = {
      deps: {
        attachmentStore: {
          prepareForPrompt: vi.fn().mockResolvedValue([
            {
              id: "44444444-4444-4444-8444-444444444444",
              name: "manual.pdf",
              mediaType: "application/pdf",
              sizeBytes: 1024,
              status: "ready",
              unit: "page",
              unitCount: 3,
            },
          ]),
        },
      },
    } as unknown as WorkspaceGraphFactory;

    const out = await buildPromptWithAttachments({
      factory,
      sessionId: "33333333-3333-4333-8333-333333333333",
      text: "review this",
      attachmentIds: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(out.text).toContain('<piabyss-attachments version="1">');
    expect(out.text).toContain("manual.pdf");
    expect(out.attachmentIds).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });
});

describe("segmentSessionName（打盹归档名）", () => {
  it("title 优先于 handoff，handoff 优先于睡觉短语；空串视同缺省", () => {
    expect(segmentSessionName("整理三站价格表", "下一段继续对价", "打个盹~")).toBe(
      "整理三站价格表",
    );
    expect(segmentSessionName(null, "上一段在改 OKXBot 前端", "打个盹~")).toBe(
      "上一段在改 OKXBot 前端",
    );
    expect(segmentSessionName("  ", "", "我先打个盹~")).toBe("我先打个盹~");
    expect(segmentSessionName(null, null, "  小憩片刻 💤  ")).toBe("小憩片刻 💤");
  });

  it("压成单行并按 40 字截断（超出加省略号）", () => {
    expect(segmentSessionName("多\n行\r\n标  题", null, "短语")).toBe("多 行 标 题");
    const long = "很长".repeat(30); // 60 字
    expect(segmentSessionName(long, null, "短语")).toBe(`${"很长".repeat(20)}…`);
    const fits = "刚好".repeat(20); // 40 字
    expect(segmentSessionName(fits, null, "短语")).toBe(fits);
  });
});

describe("委派短名与消息锚点（v0.5.0 契约）", () => {
  it("registerDispatch 记下 taskName / sessionName；未传一律 null", () => {
    const agentDir = freshAgentDir();
    const named = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      task: "把登录相关的测试全部跑一遍",
      agentDir,
      taskName: "跑登录测试",
      sessionName: "登录修复",
    });
    expect(named.taskName).toBe("跑登录测试");
    expect(named.sessionName).toBe("登录修复");
    expect(named.dispatchMessageId).toBeNull();
    expect(named.reportMessageId).toBeNull();

    const legacy = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s2",
      sessionPath: "C:/s2.jsonl",
      task: "旧版插件没传短名",
      agentDir,
    });
    expect(legacy.taskName).toBeNull();
    expect(legacy.sessionName).toBeNull();
  });

  it("锚点只写一次：重复回执不覆盖派发消息，两个锚点互不影响", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      task: "t",
      agentDir,
    });
    expect(
      setDispatchMessageAnchor(record.id, agentDir, {
        dispatchMessageId: "entry-1",
        reportMessageId: "entry-r1",
      }),
    ).not.toBeNull();
    expect(
      setDispatchMessageAnchor(record.id, agentDir, {
        dispatchMessageId: "entry-2",
        reportMessageId: "entry-r2",
      }),
    ).toBeNull();
    const live = findDispatchById(record.id)!;
    expect(live.dispatchMessageId).toBe("entry-1");
    expect(live.reportMessageId).toBe("entry-r1");
    // 未登记的 id / 空锚点都不落盘。
    expect(
      setDispatchMessageAnchor("pix_missing", agentDir, { dispatchMessageId: "x" }),
    ).toBeNull();
    expect(setDispatchMessageAnchor(record.id, agentDir, { reportMessageId: null })).toBeNull();
  });

  it("锚点与短名跨重启存活（dispatches.json 往返）", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      task: "任务全文",
      agentDir,
      taskName: "短名",
      sessionName: "会话名",
    });
    setDispatchMessageAnchor(record.id, agentDir, {
      dispatchMessageId: "entry-d",
      reportMessageId: "entry-r",
    });
    resetPixieStateForTests();
    const [loaded] = listDispatches(10, agentDir);
    expect(loaded).toMatchObject({
      id: record.id,
      taskName: "短名",
      sessionName: "会话名",
      dispatchMessageId: "entry-d",
      reportMessageId: "entry-r",
    });
  });

  it("旧 dispatches.json 没有这些字段：读回来是 null，不报错", () => {
    const agentDir = freshAgentDir();
    mkdirSync(pixieDir(agentDir), { recursive: true });
    writeFileSync(
      join(pixieDir(agentDir), "dispatches.json"),
      JSON.stringify({
        version: 1,
        records: [
          {
            id: "pix_old",
            status: "reported",
            kind: "done",
            cwd: "C:/ws",
            sessionId: "s1",
            sessionPath: "C:/s1.jsonl",
            task: "升级前受理的任务",
            report: "done",
            question: null,
            options: [],
            createdAt: Date.now() - 60_000,
            reportedAt: Date.now(),
            stale: false,
            originSessionId: "seg-1",
          },
        ],
      }),
      "utf8",
    );
    const [loaded] = listDispatches(10, agentDir);
    expect(loaded?.id).toBe("pix_old");
    expect(loaded?.taskName ?? null).toBeNull();
    expect(loaded?.sessionName ?? null).toBeNull();
    expect(loaded?.dispatchMessageId ?? null).toBeNull();
    expect(loaded?.reportMessageId ?? null).toBeNull();
  });

  it("短名裁剪：≤20 码位，与会话名是两个语义", () => {
    expect(clipPixieShortName("一二三四五六七八九十一二三四五六七八九十一二三")).toBe(
      "一二三四五六七八九十一二三四五六七八九十",
    );
    expect(pixieFallbackName("  多   行\n任务  ")).toBe("多 行 任务");
  });
});
