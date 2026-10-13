import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askDispatch,
  ensurePixiePersonaFile,
  failDispatch,
  findDispatchBySession,
  hasActiveDispatchFor,
  listDispatches,
  parsePixieModelRef,
  reactivateDispatchAfterReply,
  registerDispatch,
  resetPixieStateForTests,
  resolvePixieWorkspacePath,
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
