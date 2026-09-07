import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ensurePiHostRuntime } from "./pi-host-bootstrap-runtime.mjs";
import { detachNodeModulesLinks, snapshotNodeModulesGraph } from "./portable-node-modules.mjs";

const CACHE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

test("dead cache-lock owner is recovered before installation", async (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const archiveHash = createHash("sha256").update("archive-v1").digest("hex");
  const lockDir = join(layout.cacheRoot, ".locks", archiveHash);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", startedAt: 0 })}\n`,
  );
  const calls = { count: 0 };

  const entry = await ensurePiHostRuntime({
    resourceDir: layout.resourceDir,
    cacheRoot: layout.cacheRoot,
    extractArchive: fakeExtractor(layout, calls),
    lockPollMs: 5,
  });

  assert.equal(existsSync(entry), true);
  assert.equal(calls.count, 1);
  assert.deepEqual(readdirSync(join(layout.cacheRoot, ".locks")), []);
});

function writePackage(path, metadata) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(path, "index.js"), "export default true;\n");
}

function linkDirectory(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(
    process.platform === "win32" ? target : relative(dirname(path), target),
    path,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function writeResourceMetadata(resourceDir, archiveBytes, links, graph) {
  const zipPath = join(resourceDir, "node_modules.zip");
  const linksPath = join(resourceDir, "NODE_MODULES_LINKS.json");
  const graphPath = join(resourceDir, "NODE_MODULES_GRAPH.json");
  writeFileSync(zipPath, archiveBytes);
  writeFileSync(linksPath, `${JSON.stringify(links, null, 2)}\n`);
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    join(resourceDir, "STAGING.json"),
    `${JSON.stringify(
      {
        hostRuntimePackagedInZip: true,
        hostCacheSchemaVersion: 1,
        nodeModulesZipSha256: digest(archiveBytes),
        nodeModulesLinksSha256: digest(Buffer.from(`${JSON.stringify(links, null, 2)}\n`)),
        nodeModulesGraphSha256: digest(Buffer.from(`${JSON.stringify(graph, null, 2)}\n`)),
      },
      null,
      2,
    )}\n`,
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piabyss-host-cache-"));
  const resourceDir = join(root, "resources");
  const payloadDir = join(root, "payload");
  const cacheRoot = join(root, "cache");
  const nodeModules = join(payloadDir, "node_modules");
  const left = join(nodeModules, ".pnpm", "left@1", "node_modules", "left");
  const right = join(nodeModules, ".pnpm", "right@1", "node_modules", "right");
  const sharedOne = join(nodeModules, ".pnpm", "shared@1", "node_modules", "shared");
  const sharedTwo = join(nodeModules, ".pnpm", "shared@2", "node_modules", "shared");
  const dependencies = { left: "1.0.0", right: "1.0.0" };
  mkdirSync(resourceDir, { recursive: true });
  writePackage(left, { name: "left", version: "1.0.0", dependencies: { shared: "1.0.0" } });
  writePackage(right, { name: "right", version: "1.0.0", dependencies: { shared: "2.0.0" } });
  writePackage(sharedOne, { name: "shared", version: "1.0.0" });
  writePackage(sharedTwo, { name: "shared", version: "2.0.0" });
  linkDirectory(left, join(nodeModules, "left"));
  linkDirectory(right, join(nodeModules, "right"));
  linkDirectory(sharedOne, join(dirname(left), "shared"));
  linkDirectory(sharedTwo, join(dirname(right), "shared"));
  const graph = snapshotNodeModulesGraph(nodeModules, dependencies);
  const { manifest } = detachNodeModulesLinks(nodeModules);
  const runtimeDir = join(payloadDir, "host-runtime");
  writePackage(runtimeDir, {
    name: "piabyss-host-release",
    version: "1.0.0",
    type: "module",
    dependencies,
  });
  writeFileSync(join(runtimeDir, "host-main.js"), "export const ready = true;\n");
  writeResourceMetadata(resourceDir, Buffer.from("archive-v1"), manifest, graph);
  return { root, resourceDir, payloadDir, cacheRoot, manifest, graph };
}

function fakeExtractor(layout, calls, delayMs = 0) {
  return async (_zipPath, destination) => {
    calls.count += 1;
    if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    cpSync(layout.payloadDir, destination, { recursive: true });
  };
}

test("concurrent startup installs one atomically validated cache", async (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const beforeResources = readdirSync(layout.resourceDir).sort();
  const calls = { count: 0 };
  const options = {
    resourceDir: layout.resourceDir,
    cacheRoot: layout.cacheRoot,
    extractArchive: fakeExtractor(layout, calls, 30),
    lockPollMs: 5,
  };

  const [first, second] = await Promise.all([
    ensurePiHostRuntime(options),
    ensurePiHostRuntime(options),
  ]);

  assert.equal(first, second);
  assert.equal(calls.count, 1);
  assert.equal(existsSync(first), true);
  assert.deepEqual(readdirSync(layout.resourceDir).sort(), beforeResources);
  assert.equal(
    readdirSync(layout.cacheRoot).some((name) => name.startsWith(".tmp-")),
    false,
  );
});

test("archive hash changes select a new cache directory", async (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const calls = { count: 0 };
  const options = {
    resourceDir: layout.resourceDir,
    cacheRoot: layout.cacheRoot,
    extractArchive: fakeExtractor(layout, calls),
  };
  const first = await ensurePiHostRuntime(options);
  writeResourceMetadata(
    layout.resourceDir,
    Buffer.from("archive-v2"),
    layout.manifest,
    layout.graph,
  );
  const second = await ensurePiHostRuntime(options);

  assert.notEqual(dirname(first), dirname(second));
  assert.equal(calls.count, 2);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
});

test("failed extraction leaves neither a final cache nor a stale lock", async (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));

  await assert.rejects(
    ensurePiHostRuntime({
      resourceDir: layout.resourceDir,
      cacheRoot: layout.cacheRoot,
      extractArchive: async (_zipPath, destination) => {
        writeFileSync(join(destination, "partial"), "partial");
        throw new Error("extract failed");
      },
    }),
    /extract failed/,
  );

  const cacheEntries = readdirSync(layout.cacheRoot);
  assert.equal(
    cacheEntries.some((name) => CACHE_HASH_PATTERN.test(name)),
    false,
  );
  assert.deepEqual(readdirSync(join(layout.cacheRoot, ".locks")), []);
  assert.equal(
    cacheEntries.some((name) => name.startsWith(".tmp-")),
    false,
  );
});
