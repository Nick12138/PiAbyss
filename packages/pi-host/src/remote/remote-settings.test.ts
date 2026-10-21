import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTOR_SOURCE,
  RemoteSettingsStore,
  defaultRemoteSettings,
  normalizeServerUrl,
} from "./remote-settings.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "piabyss-remote-settings-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("normalizeServerUrl", () => {
  it("treats empty input as the official cloud", () => {
    expect(normalizeServerUrl("")).toEqual({ serverUrl: "", error: null });
    expect(normalizeServerUrl("   ")).toEqual({ serverUrl: "", error: null });
  });

  it("adds the https scheme and strips trailing slashes", () => {
    expect(normalizeServerUrl("aa.example.com/")).toEqual({
      serverUrl: "https://aa.example.com",
      error: null,
    });
  });

  it("strips a pasted /api/v2 suffix", () => {
    expect(normalizeServerUrl("https://aa.example.com/api/v2/")).toEqual({
      serverUrl: "https://aa.example.com",
      error: null,
    });
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(normalizeServerUrl("https://example.com/agents-anywhere/api/v2")).toEqual({
      serverUrl: "https://example.com/agents-anywhere",
      error: null,
    });
  });

  it("keeps http for local development", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8000")).toEqual({
      serverUrl: "http://127.0.0.1:8000",
      error: null,
    });
  });

  it("rejects unsupported schemes and whitespace", () => {
    expect(normalizeServerUrl("ftp://aa.example.com").error).toBeTruthy();
    expect(normalizeServerUrl("https://aa.example.com/a b").error).toBeTruthy();
  });
});

describe("RemoteSettingsStore", () => {
  it("returns defaults when nothing is saved yet", async () => {
    const dir = await tempDir();
    const store = new RemoteSettingsStore(dir);
    expect(await store.load()).toEqual(defaultRemoteSettings());
    expect((await store.load()).connectorSource).toBe(DEFAULT_CONNECTOR_SOURCE);
  });

  it("persists a patch and keeps untouched fields", async () => {
    const dir = await tempDir();
    const store = new RemoteSettingsStore(dir);
    await store.save({ enabled: true, serverUrl: "aa.example.com/" });
    const saved = await store.save({ autoStart: false });
    expect(saved).toMatchObject({
      enabled: true,
      autoStart: false,
      serverUrl: "https://aa.example.com",
      connectorSource: DEFAULT_CONNECTOR_SOURCE,
    });
    const raw = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    expect(raw.enabled).toBe(true);
    expect(raw.serverUrl).toBe("https://aa.example.com");
  });

  it("rejects an invalid server address instead of writing it", async () => {
    const dir = await tempDir();
    const store = new RemoteSettingsStore(dir);
    await expect(store.save({ serverUrl: "ftp://nope" })).rejects.toThrow();
    expect((await store.load()).serverUrl).toBe("");
  });

  it("recovers from a corrupt file without throwing", async () => {
    const dir = await tempDir();
    const store = new RemoteSettingsStore(dir);
    await writeFile(store.path, "{not json", "utf8");
    expect(await store.load()).toEqual(defaultRemoteSettings());
  });

  it("clears optional overrides", async () => {
    const dir = await tempDir();
    const store = new RemoteSettingsStore(dir);
    await store.save({ uvPath: "/opt/uv/bin/uv", pypiIndex: "https://mirror.example/simple" });
    const cleared = await store.save({ uvPath: null, pypiIndex: null });
    expect(cleared.uvPath).toBeNull();
    expect(cleared.pypiIndex).toBeNull();
  });
});
