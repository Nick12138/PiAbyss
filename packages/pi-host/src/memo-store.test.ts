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

  it("remove deletes the note and its image directory", async () => {
    const { store } = await tempLayout();
    const note = store.create({
      type: "memo",
      title: "t",
      contentMd: "c",
      images: [{ fileName: "a.png", mediaType: "image/png", dataBase64: PNG_BASE64 }],
    });
    store.remove(note.id);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(store.rootDir, "images", note.id))).toBe(false);
    expect(() => store.remove(note.id)).toThrow();
  });

  it("throws on unknown note ids", async () => {
    const { store } = await tempLayout();
    expect(() =>
      store.update("00000000-0000-4000-8000-00000000000f", { status: "done" }),
    ).toThrow();
    expect(() => store.remove("00000000-0000-4000-8000-00000000000f")).toThrow();
  });
});
