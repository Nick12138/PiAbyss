import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askDispatch,
  configurePixieRuntime,
  ensureCurrentSegment,
  ensurePixiePersonaFile,
  failDispatch,
  findDispatchBySession,
  hasActiveDispatchFor,
  listDispatches,
  parsePixieModelRef,
  pixieRundown,
  pixieSetModel,
  pixieState,
  reactivateDispatchAfterReply,
  registerDispatch,
  resetPixieStateForTests,
  resolvePixieWorkspacePath,
  sendPixieMessage,
  settleDispatch,
  pixieStaleMs,
  pixieSegmentMaxTurns,
  pixieTranscriptFrom,
  setPixieContext,
  getKnownWorkspaces,
} from "./pixie-agent-runner.js";
import { buildDispatchTaskPrompt } from "./pixie-controller.js";
import { buildPromptWithAttachments, toSdkImages } from "./agent-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { localDayKey } from "./pixie-usage.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshAgentDir(): string {
  resetPixieStateForTests();
  return mkdtempSync(join(tmpdir(), "pixie-test-"));
}

const layouts: TempAgentLayout[] = [];

afterEach(() => {
  resetPixieStateForTests();
  for (const layout of layouts.splice(0)) layout.cleanup();
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
    // Backdate so the stale sweep (triggered by later pixieState calls) cannot
    // poison the ordering assertion below.
    (record as { createdAt: number }).createdAt = Date.now() - pixieStaleMs() - 60_000;
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
    const state = pixieState(agentDir);
    const stale = state.dispatches.find((d) => d.id === record.id);
    expect(stale?.stale).toBe(true);
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
    const state = pixieState(agentDir);
    const reloaded = state.dispatches.find((d) => d.id === record.id);
    expect(reloaded?.status).toBe("reported");
    expect(reloaded?.report).toBe("done!");
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

    const state = pixieState(agentDir);
    expect(state.askPending).toBe(true);

    const reply = reactivateDispatchAfterReply(record.id, "方案 A", agentDir);
    expect("record" in reply && reply.record.status).toBe("dispatched");
    expect(pixieState(agentDir).askPending).toBe(false);

    // Reply on a non-awaiting record fails.
    expect("error" in reactivateDispatchAfterReply(record.id, "again", agentDir)).toBe(true);
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

describe("pixie timeline placeholder", () => {
  it("renders an archived segment with empty messages instead of crashing", () => {
    const agentDir = freshAgentDir();
    // No sessions were ever created: the timeline is empty and the state is
    // the neutral pre-first-message shape.
    const state = pixieState(agentDir);
    expect(state.resident).toBe(false);
    expect(state.segments).toEqual([]);
    expect(state.askPending).toBe(false);
    expect(state.messages).toEqual([]);
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

describe("pixie restart resume", () => {
  /**
   * Write the timeline a running Host leaves behind: one OPEN segment pointer
   * (endedAt=null) to a session file that is still on disk. `pixie.state`
   * counts as resident only while that segment is actually back in memory.
   */
  function writeOpenSegment(agentDir: string, sessionPath: string): void {
    const dir = join(agentDir, "piabyss", "pixie");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify({
        version: 1,
        segments: [
          {
            id: "seg_restart",
            sessionId: "sess_restart",
            sessionPath,
            startedAt: Date.now() - 60_000,
            endedAt: null,
            separator: null,
            reason: null,
            handoff: null,
          },
        ],
      }),
      "utf8",
    );
  }

  it("宿主重启后按时间线重建当前段，resident 由 false 变 true", async () => {
    const layout = createTempAgentLayout("piabyss-pixie-resume-");
    layouts.push(layout);
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    configurePixieRuntime(modelRuntime);

    // 重启前留下的现场：段会话真的写盘过（含一条用户消息）。
    const pixieCwd = resolvePixieWorkspacePath(layout.agentDir);
    mkdirSync(pixieCwd, { recursive: true });
    const sessionManager = SessionManager.create(
      pixieCwd,
      join(layout.agentDir, "sessions", "pixie-test"),
    );
    sessionManager.appendMessage({
      role: "user",
      content: "重启前的一句话",
      timestamp: Date.now(),
    });
    const sessionPath = sessionManager.getSessionFile();
    expect(sessionPath).toBeTruthy();
    resetPixieStateForTests(); // Host 重启：内存里的段没了，磁盘还在

    writeOpenSegment(layout.agentDir, sessionPath!);

    // 纯快照路径不重建（这就是「打个盹」按钮曾经被卡死的那个值）。
    expect(pixieState(layout.agentDir).resident).toBe(false);
    expect(pixieState(layout.agentDir).segments[0]?.messages[0]?.text).toBe("重启前的一句话");

    const resumed = await ensureCurrentSegment(layout.agentDir);
    expect(resumed).not.toBeNull();
    const state = pixieState(layout.agentDir);
    expect(state.resident).toBe(true);
    expect(state.sessionPath).toBe(sessionPath);
    expect(resumed!.record.id).toBe("seg_restart");
    resumed!.session.dispose();
  });

  it("已经是内存里的段时直接返回，不重复打开", async () => {
    const layout = createTempAgentLayout("piabyss-pixie-resident-");
    layouts.push(layout);
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    configurePixieRuntime(modelRuntime);

    const pixieCwd = resolvePixieWorkspacePath(layout.agentDir);
    mkdirSync(pixieCwd, { recursive: true });
    const sessionManager = SessionManager.create(
      pixieCwd,
      join(layout.agentDir, "sessions", "pixie-test"),
    );
    sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    writeOpenSegment(layout.agentDir, sessionManager.getSessionFile()!);

    const first = await ensureCurrentSegment(layout.agentDir);
    const second = await ensureCurrentSegment(layout.agentDir);
    expect(second).toBe(first);
    first!.session.dispose();
  });

  it("恢复失败退化为归档占位，且不在每次轮询里重试", async () => {
    const agentDir = freshAgentDir();
    // 段指针指向一个写坏的会话文件（截断/半截落盘的现场）：open 必然抛错。
    const broken = join(agentDir, "broken-session.jsonl");
    writeFileSync(broken, "这不是一个合法的 pi 会话\n", "utf8");
    writeOpenSegment(agentDir, broken);

    await expect(ensureCurrentSegment(agentDir)).resolves.toBeNull();
    expect(pixieState(agentDir).resident).toBe(false);
    expect(pixieState(agentDir).segments[0]?.messages).toEqual([]);
    // 第二次直接短路（resumeFailed 记住段 id），不会每次轮询都去开一遍文件。
    await expect(ensureCurrentSegment(agentDir)).resolves.toBeNull();
    expect(pixieState(agentDir).resident).toBe(false);
  });

  it("并发调用只打开一次会话（单飞）", async () => {
    const layout = createTempAgentLayout("piabyss-pixie-singleflight-");
    layouts.push(layout);
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    configurePixieRuntime(modelRuntime);

    const pixieCwd = resolvePixieWorkspacePath(layout.agentDir);
    mkdirSync(pixieCwd, { recursive: true });
    const sessionManager = SessionManager.create(
      pixieCwd,
      join(layout.agentDir, "sessions", "pixie-test"),
    );
    sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    writeOpenSegment(layout.agentDir, sessionManager.getSessionFile()!);
    resetPixieStateForTests();

    // 轮询与发送同时撞上来：两次调用拿到的必须是同一个运行时。
    const [first, second] = await Promise.all([
      ensureCurrentSegment(layout.agentDir),
      ensureCurrentSegment(layout.agentDir),
    ]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    first!.session.dispose();
  });
});

describe("pixie rundown（pixie.rundown）", () => {
  it("无驻留段时返回 null —— 读操作绝不为了统计而建段", async () => {
    const agentDir = freshAgentDir();
    await expect(pixieRundown(agentDir)).resolves.toBeNull();
    const state = pixieState(agentDir);
    expect(state.resident).toBe(false);
    expect(state.segments).toEqual([]);
  });
});

describe("pixie 段落模型选择（pixie.setModel）", () => {
  async function layoutWithRuntime(prefix: string) {
    const layout = createTempAgentLayout(prefix);
    layouts.push(layout);
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    configurePixieRuntime(modelRuntime);
    return layout;
  }

  it("非法格式（无斜杠 / 空 provider / 空 id）⇒ 明确报错，不落到 SDK", async () => {
    const layout = await layoutWithRuntime("piabyss-pixie-setmodel-bad-");
    for (const bad of ["gpt-4o", "/nope", "openai/"]) {
      const out = await pixieSetModel(layout.agentDir, bad);
      expect(out.ok).toBe(false);
      expect(out.error).toContain("provider/id");
    }
    (await ensureCurrentSegment(layout.agentDir))?.session.dispose();
  });

  it("null 清除当前段模型选择（回落全局默认），current 归 null", async () => {
    const layout = await layoutWithRuntime("piabyss-pixie-setmodel-clear-");
    // 首次写操作会懒建一个段，这正是 clearModel 的作用对象。
    const out = await pixieSetModel(layout.agentDir, null);
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(out.current).toBeNull();
    (await ensureCurrentSegment(layout.agentDir))?.session.dispose();
  });

  it("格式合法但 Provider 未启用 ⇒ ok=false 且保留当前选择", async () => {
    const layout = await layoutWithRuntime("piabyss-pixie-setmodel-disabled-");
    const out = await pixieSetModel(layout.agentDir, "no-such-provider/some-model");
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    (await ensureCurrentSegment(layout.agentDir))?.session.dispose();
  });
});

describe("pixie 发送附件（pixie.send）", () => {
  it("图片按 SDK ImageContent 透传到 session.prompt 的 images 选项", async () => {
    const layout = createTempAgentLayout("piabyss-pixie-send-img-");
    layouts.push(layout);
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    configurePixieRuntime(modelRuntime);

    // 先懒建一个段（写操作），再把同一个运行时的 prompt 换成 spy。
    await pixieSetModel(layout.agentDir, null);
    const runtime = await ensureCurrentSegment(layout.agentDir);
    expect(runtime).not.toBeNull();
    const promptSpy = vi.fn(async () => undefined);
    (runtime!.session as unknown as { prompt: unknown }).prompt = promptSpy;

    const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const out = await sendPixieMessage({ agentDir: layout.agentDir, text: "看看这张图", images: [image] });
    expect(out.ok).toBe(true);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const [promptText, options] = promptSpy.mock.calls[0] as unknown as [
      string,
      { images?: unknown[] } | undefined,
    ];
    expect(promptText).toContain("看看这张图");
    expect(options?.images).toEqual([image]);
    runtime!.session.dispose();
  });

  it("不带图片时不传 images 选项（保持既有 prompt 调用形态）", async () => {
    const layout = createTempAgentLayout("piabyss-pixie-send-plain-");
    layouts.push(layout);
    const { modelRuntime } = await createTestModelServices(layout.agentDir);
    configurePixieRuntime(modelRuntime);

    await pixieSetModel(layout.agentDir, null);
    const runtime = await ensureCurrentSegment(layout.agentDir);
    const promptSpy = vi.fn(async () => undefined);
    (runtime!.session as unknown as { prompt: unknown }).prompt = promptSpy;

    await sendPixieMessage({ agentDir: layout.agentDir, text: "只有文字" });
    const [, options] = promptSpy.mock.calls[0] as unknown as [string, unknown];
    expect(options).toBeUndefined();
    runtime!.session.dispose();
  });

  it("toSdkImages 把协议图片映射成 SDK ImageContent（与 agent.prompt 同一转换）", () => {
    expect(toSdkImages([{ mediaType: "image/png", data: "aGk=" }])).toEqual([
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
    expect(toSdkImages([])).toBeUndefined();
    expect(toSdkImages(undefined)).toBeUndefined();
  });

  it("buildPromptWithAttachments 把 attachmentIds 解析成引用块（与 agent.prompt 同一实现）", async () => {
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
