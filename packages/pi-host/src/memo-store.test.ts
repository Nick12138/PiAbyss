import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoNote } from "@piabyss/protocol";
import { MemoStore } from "./memo-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ agentDir: string; store: MemoStore }> {
  const root = await mkdtemp(join(tmpdir(), "piabyss-memo-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  return { agentDir, store: new MemoStore(agentDir) };
}

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

describe("MemoStore", () => {
  it("starts empty and persists across instances", async () => {
    const { agentDir, store } = await tempLayout();
    expect(store.list()).toEqual([]);

    const note = store.create({ type: "memo", title: "第一条", contentMd: "内容" });
    expect(store.list()).toHaveLength(1);

    // 新实例读同一份数据（磁盘权威，无内存缓存）。
    const reopened = new MemoStore(agentDir);
    expect(reopened.list().map((entry) => entry.id)).toEqual([note.id]);
  });

  it("creates notes with normalized tags and defaults", async () => {
    const { store } = await tempLayout();
    const note = store.create({
      type: "task",
      title: "  带标签  ",
      contentMd: "正文",
      tags: ["#A", "a", "b ", ""],
      workspaceHint: " PiAbyss ",
    });
    expect(note.title).toBe("带标签");
    expect(note.status).toBe("open");
    // 大小写去重 + 去空白 + 丢弃空串，保留首个书写形式。
    expect(note.tags).toEqual(["A", "b"]);
    expect(note.workspaceHint).toBe("PiAbyss");
    expect(note.completedAt).toBeNull();
  });

  it("rejects invalid create input", async () => {
    const { store } = await tempLayout();
    expect(() => store.create({ type: "memo", title: "  ", contentMd: "x" })).toThrow();
    expect(() => store.create({ type: "bogus" as "memo", title: "t", contentMd: "x" })).toThrow();
    expect(() =>
      store.create({
        type: "memo",
        title: "t",
        contentMd: "x",
        images: [{ fileName: "a.png", mediaType: "text/plain", dataBase64: PNG_BASE64 }],
      }),
    ).toThrow();
  });

  it("updates fields and manages completion timestamps", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "idea", title: "t", contentMd: "c" });

    const done = store.update(note.id, { status: "done" });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();

    const reopened = store.update(note.id, { status: "open" });
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();

    const retitled = store.update(note.id, { title: "新标题", tags: ["x"] });
    expect(retitled.title).toBe("新标题");
    expect(retitled.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
  });

  it("add and remove images on update, cleaning up files", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "memo", title: "t", contentMd: "c" });

    const withImage = store.update(note.id, {
      addImages: [{ fileName: "shot.png", mediaType: "image/png", dataBase64: PNG_BASE64 }],
    });
    expect(withImage.images).toHaveLength(1);
    const image = withImage.images[0] as MemoNote["images"][number];
    expect(image.bytes).toBe(8);

    const read = store.readImage(note.id, image.id);
    expect(read.mediaType).toBe("image/png");
    expect(Buffer.from(read.dataBase64, "base64")).toEqual(Buffer.from(PNG_BASE64, "base64"));

    const cleaned = store.update(note.id, { removeImageIds: [image.id] });
    expect(cleaned.images).toHaveLength(0);
    expect(existsSync(join(store.rootDir, "images", note.id, image.fileName))).toBe(false);

    // 读取已删除的图片 → 资源不存在。
    expect(() => store.readImage(note.id, image.id)).toThrow();
  });

  it("remove marks a tombstone (kept for sync), purge physically deletes", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({
      type: "memo",
      title: "t",
      contentMd: "c",
      images: [{ fileName: "a.png", mediaType: "image/png", dataBase64: PNG_BASE64 }],
    });
    const removed = store.remove(note.id);
    expect(removed.deletedAt).not.toBeNull();
    // list 过滤墓碑；listAll / 图片文件保留。
    expect(store.list()).toEqual([]);
    expect(store.listAll()).toHaveLength(1);
    expect(existsSync(join(store.rootDir, "images", note.id))).toBe(true);
    expect(store.get(note.id)).toBeNull();

    // 未过期的墓碑不会被清理（生产调用传 now - 30 天）。
    expect(store.purgeDeleted(Date.now() - 30 * 24 * 3600 * 1000)).toHaveLength(0);
    // 过期后物理删除。
    const purged = store.purgeDeleted(Number.MAX_SAFE_INTEGER);
    expect(purged.map((entry) => entry.id)).toEqual([note.id]);
    expect(store.listAll()).toEqual([]);
    expect(existsSync(join(store.rootDir, "images", note.id))).toBe(false);

    // 重开实例后墓碑数据兼容（listAll 含 deletedAt 字段）。
    const reopened = new MemoStore(agentDir);
    expect(reopened.list()).toEqual([]);
  });

  it("replaceAll replaces the whole note set without touching image files", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "memo", title: "a", contentMd: "x" });
    store.replaceAll([note]);
    expect(store.list().map((entry) => entry.id)).toEqual([note.id]);
    store.replaceAll([]);
    expect(store.list()).toEqual([]);
    // 图片目录不受 replaceAll 影响。
    expect(existsSync(store.rootDir)).toBe(true);
  });

  it("throws on unknown note ids", async () => {
    const { store } = await tempLayout();
    expect(() =>
      store.update("00000000-0000-4000-8000-00000000000f", { status: "done" }),
    ).toThrow();
    expect(() => store.remove("00000000-0000-4000-8000-00000000000f")).toThrow();
    expect(() =>
      store.completeWithResult("00000000-0000-4000-8000-00000000000f", {
        resultMd: "x",
        sessionId: "s1",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      }),
    ).toThrow();
  });

  it("completeWithResult marks done and records the summary with session info", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "task", title: "t", contentMd: "c" });

    const done = store.completeWithResult(note.id, {
      resultMd: "  已修复，测试通过。  ",
      sessionId: " session-1 ",
      sessionPath: "D:/sessions/session-1.jsonl",
      sessionTitle: " 处理备忘录 ",
      sessionCwd: "D:/work/PiAbyss",
    });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    expect(done.result).not.toBeNull();
    expect(done.result?.resultMd).toBe("已修复，测试通过。");
    expect(done.result?.sessionId).toBe("session-1");
    expect(done.result?.sessionTitle).toBe("处理备忘录");
    expect(done.result?.sessionCwd).toBe("D:/work/PiAbyss");
    expect(typeof done.result?.at).toBe("number");

    // 覆盖式更新：再次 complete 替换旧总结。
    const again = store.completeWithResult(note.id, {
      resultMd: "第二轮处理完成。",
      sessionId: "session-2",
      sessionPath: null,
      sessionTitle: null,
      sessionCwd: null,
    });
    expect(again.result?.resultMd).toBe("第二轮处理完成。");
    expect(again.result?.sessionId).toBe("session-2");
    expect(again.result?.sessionPath).toBeNull();
  });

  it("completeWithResult rejects empty summaries and missing session info", async () => {
    const { store } = await tempLayout();
    const note = store.create({ type: "memo", title: "t", contentMd: "c" });
    expect(() =>
      store.completeWithResult(note.id, {
        resultMd: "   ",
        sessionId: "s1",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      }),
    ).toThrow();
    expect(() =>
      store.completeWithResult(note.id, {
        resultMd: "x",
        sessionId: "  ",
        sessionPath: null,
        sessionTitle: null,
        sessionCwd: null,
      }),
    ).toThrow();
  });

  it("reads legacy notes without a result field as result: null", async () => {
    const { agentDir, store } = await tempLayout();
    const note = store.create({ type: "memo", title: "t", contentMd: "c" });

    // 模拟 v1 旧数据：手工抹去 result 字段后重新读取。
    const { readFileSync, writeFileSync } = await import("node:fs");
    const filePath = join(store.rootDir, "notes.json");
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      notes: Record<string, unknown>[];
    };
    for (const entry of raw.notes) delete entry.result;
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const reopened = new MemoStore(agentDir);
    const loaded = reopened.list().find((entry) => entry.id === note.id);
    expect(loaded?.result).toBeNull();
  });
});
