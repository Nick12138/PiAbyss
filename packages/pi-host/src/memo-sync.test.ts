import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoSync, scheduleMemoAutoSync } from "./memo-sync.js";
import { MemoStore } from "./memo-store.js";

const tempDirs: string[] = [];
vi.useFakeTimers();

afterEach(async () => {
  vi.clearAllTimers();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ agentDir: string; store: MemoStore; sync: MemoSync }> {
  const root = await mkdtemp(join(tmpdir(), "piabyss-memo-sync-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  return { agentDir, store: new MemoStore(agentDir), sync: new MemoSync(agentDir) };
}

const CONFIG = {
  accountId: "abc123",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  bucket: "memos",
  autoSync: false,
};

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

/** 收集 R2 请求并返回键 → 体的映射的 mock fetch。 */
function mockR2() {
  const objects = new Map<string, Buffer>();
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = input as URL;
    const key = url.pathname.replace(/^\/memos\//, "");
    if ((init?.method ?? "GET") === "PUT") {
      objects.set(key, Buffer.from(init?.body as ArrayBuffer));
      return new Response(null, { status: 200 });
    }
    const found = objects.get(key);
    return found
      ? new Response(new Uint8Array(found), { status: 200 })
      : new Response("nope", { status: 404 });
  });
  return { objects, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("MemoSync", () => {
  it("persists config separately from sync state", async () => {
    const { agentDir, sync } = await tempLayout();
    expect(sync.getSettings().accountId).toBe("");

    sync.setConfig(CONFIG);
    const settings = sync.getSettings();
    expect(settings.accountId).toBe("abc123");
    expect(settings.lastSyncAt).toBeNull();
    expect(existsSync(join(agentDir, "piabyss", "memo", "sync-config.json"))).toBe(true);

    // 重开实例读到同一份配置。
    expect(new MemoSync(agentDir).getSettings().accountId).toBe("abc123");
  });

  it("uploads notes.json and images under the fixed prefix", async () => {
    const { store, sync } = await tempLayout();
    store.create({
      type: "memo",
      title: "带图",
      contentMd: "正文",
      images: [{ fileName: "a.png", mediaType: "image/png", dataBase64: PNG_BASE64 }],
    });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      sync.setConfig(CONFIG);
      const stats = await sync.syncNow();
      expect(stats.uploadedNotes).toBe(1);
      expect(stats.uploadedImages).toBe(1);
      expect(stats.bytes).toBeGreaterThan(0);

      const notes = JSON.parse(objects.get("piabyss/memo/notes.json")!.toString("utf8")) as {
        notes: { title: string }[];
      };
      expect(notes.notes.map((entry) => entry.title)).toEqual(["带图"]);
      expect(objects.get("piabyss/memo/images/")!).toBeUndefined();
      const imageKey = [...objects.keys()].find(
        (key) => key.includes("/images/") && key.endsWith(".png"),
      );
      expect(imageKey).toBeDefined();
      expect([...objects.get(imageKey!)!]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      // 状态回写成功。
      const settings = sync.getSettings();
      expect(settings.lastSyncOk).toBe(true);
      expect(settings.lastSyncError).toBeNull();
      expect(settings.lastSyncAt).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records failures in lastSync state", async () => {
    const { sync } = await tempLayout();
    sync.setConfig(CONFIG);
    const failing = vi.fn(async () => new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", failing as unknown as typeof fetch);
    try {
      await expect(sync.syncNow()).rejects.toMatchObject({ status: 403 });
      const settings = sync.getSettings();
      expect(settings.lastSyncOk).toBe(false);
      expect(settings.lastSyncError).toContain("403");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("syncNow refuses to run without configuration", async () => {
    const { sync } = await tempLayout();
    await expect(sync.syncNow()).rejects.toThrow("尚未配置");
  });

  it("scheduleAutoSync debounces mutations and skips when disabled", async () => {
    const { agentDir, store, sync } = await tempLayout();
    sync.setConfig({ ...CONFIG, autoSync: true });
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      store.create({ type: "memo", title: "a", contentMd: "x" });
      scheduleMemoAutoSync(agentDir);
      scheduleMemoAutoSync(agentDir); // 防抖窗口内重复触发只算一次。
      await vi.advanceTimersByTimeAsync(6_000);
      // 防抖后一次同步 = GET 云端 notes.json + PUT 合并结果（无图片）。
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // autoSync 关闭时不触发。
      const sync2 = new MemoSync(agentDir);
      sync2.setConfig({ ...CONFIG, autoSync: false });
      store.create({ type: "memo", title: "b", contentMd: "x" });
      scheduleMemoAutoSync(agentDir);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adopts cloud-only notes and downloads their images (two-way sync)", async () => {
    const { store, sync } = await tempLayout();
    // 本地已有自己的记录。
    store.create({ type: "memo", title: "本地", contentMd: "x" });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      sync.setConfig(CONFIG);

      // 模拟另一台设备先把一条记录 + 图片放到云端。
      const cloudNote = {
        id: "cloud-note-1",
        type: "idea",
        title: "来自云端",
        contentMd: "c",
        status: "open",
        tags: [],
        workspaceHint: null,
        images: [{ id: "img-1", fileName: "b.png", mediaType: "image/png", bytes: 8 }],
        createdAt: 1,
        updatedAt: 1,
        completedAt: null,
        result: null,
        deletedAt: null,
      };
      objects.set(
        "piabyss/memo/notes.json",
        Buffer.from(JSON.stringify({ schemaVersion: 1, notes: [cloudNote] }), "utf8"),
      );
      objects.set("piabyss/memo/images/cloud-note-1/b.png", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

      const stats = await sync.syncNow();
      expect(stats.downloadedNotes).toBe(1);
      expect(stats.downloadedImages).toBe(1);

      // 云端记录进入本地，图片文件已补齐。
      const adopted = store.list().find((entry) => entry.id === "cloud-note-1");
      expect(adopted?.title).toBe("来自云端");
      expect(store.readImageFile("cloud-note-1", "b.png").byteLength).toBe(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adopts legacy cloud notes missing deletedAt/result (not treated as deleted)", async () => {
    const { store, sync } = await tempLayout();
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      sync.setConfig(CONFIG);
      // 模拟旧版本写入的云端 notes.json：记录没有 deletedAt / result 字段。
      objects.set(
        "piabyss/memo/notes.json",
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            notes: [
              {
                id: "legacy-note-1",
                type: "memo",
                title: "旧格式记录",
                contentMd: "c",
                status: "open",
                tags: [],
                workspaceHint: null,
                images: [],
                createdAt: 1,
                updatedAt: 1,
                completedAt: null,
              },
            ],
          }),
          "utf8",
        ),
      );
      await sync.syncNow();
      const adopted = store.list().find((entry) => entry.id === "legacy-note-1");
      expect(adopted?.title).toBe("旧格式记录");
      expect(adopted?.deletedAt).toBeNull();
      expect(adopted?.result).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("local deletion propagates to cloud and is not resurrected", async () => {
    const { store, sync } = await tempLayout();
    const note = store.create({ type: "memo", title: "要删的", contentMd: "x" });
    const { fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      sync.setConfig(CONFIG);
      // 第一次同步把记录推上云端。
      await sync.syncNow();
      // 本地删除（墓碑），再同步：云端被覆盖为带墓碑的记录。
      store.remove(note.id);
      const stats = await sync.syncNow();
      expect(store.list()).toEqual([]);
      // 合并结果里仍含墓碑（供其他设备学习删除）。
      expect(store.listAll()).toHaveLength(1);
      expect(stats.uploadedNotes).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an edit newer than a tombstone resurrects the note", async () => {
    const { store, sync } = await tempLayout();
    const note = store.create({ type: "memo", title: "v1", contentMd: "x" });
    const { objects, fetchImpl } = mockR2();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      sync.setConfig(CONFIG);
      await sync.syncNow(); // 推 v1 上云
      const tombstoneAt = store.remove(note.id).deletedAt as number;
      const cloudEdited = {
        ...store.listAll()[0],
        deletedAt: null,
        title: "v2 复活版",
        updatedAt: tombstoneAt + 1000,
      };
      objects.set(
        "piabyss/memo/notes.json",
        Buffer.from(JSON.stringify({ schemaVersion: 1, notes: [cloudEdited] }), "utf8"),
      );
      await sync.syncNow();
      const revived = store.list().find((entry) => entry.id === note.id);
      expect(revived?.title).toBe("v2 复活版");
      expect(revived?.deletedAt).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
