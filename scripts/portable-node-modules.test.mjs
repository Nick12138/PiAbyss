import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  assertNodeModulesGraph,
  detachNodeModulesLinks,
  restoreNodeModulesLinks,
  snapshotNodeModulesGraph,
} from "./portable-node-modules.mjs";

function writePackage(path, metadata) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(path, "index.js"), "export default true;\n");
}

function linkDirectory(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  const linkTarget = process.platform === "win32" ? target : relative(dirname(path), target);
  symlinkSync(linkTarget, path, process.platform === "win32" ? "junction" : "dir");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piabyss-portable-nm-"));
  const nodeModules = join(root, "node_modules");
  const left = join(nodeModules, ".pnpm", "left@1.0.0", "node_modules", "left");
  const right = join(nodeModules, ".pnpm", "right@1.0.0", "node_modules", "right");
  const sharedOne = join(nodeModules, ".pnpm", "shared@1.0.0", "node_modules", "shared");
  const sharedTwo = join(nodeModules, ".pnpm", "shared@2.0.0", "node_modules", "shared");
  writePackage(left, { name: "left", version: "1.0.0", dependencies: { shared: "1.0.0" } });
  writePackage(right, { name: "right", version: "1.0.0", dependencies: { shared: "2.0.0" } });
  writePackage(sharedOne, { name: "shared", version: "1.0.0" });
  writePackage(sharedTwo, { name: "shared", version: "2.0.0" });
  linkDirectory(left, join(nodeModules, "left"));
  linkDirectory(right, join(nodeModules, "right"));
  linkDirectory(sharedOne, join(dirname(left), "shared"));
  linkDirectory(sharedTwo, join(dirname(right), "shared"));
  return { root, nodeModules, left, right, sharedOne, sharedTwo };
}

test("portable link manifest preserves two versions of the same transitive dependency", (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const rootDependencies = { left: "1.0.0", right: "1.0.0" };
  const expectedGraph = snapshotNodeModulesGraph(layout.nodeModules, rootDependencies);
  assert.ok(expectedGraph.edges.includes("left@1.0.0|shared|shared@1.0.0"));
  assert.ok(expectedGraph.edges.includes("right@1.0.0|shared|shared@2.0.0"));

  const { manifest } = detachNodeModulesLinks(layout.nodeModules);
  assert.equal(manifest.links.length, 4);
  assert.equal(existsSync(join(layout.nodeModules, "left")), false);
  assert.equal(existsSync(join(layout.nodeModules, "right")), false);

  const relocatedNodeModules = join(layout.root, "relocated", "node_modules");
  mkdirSync(dirname(relocatedNodeModules), { recursive: true });
  renameSync(layout.nodeModules, relocatedNodeModules);
  assert.equal(restoreNodeModulesLinks(relocatedNodeModules, manifest), 4);
  assert.doesNotThrow(() =>
    assertNodeModulesGraph(
      relocatedNodeModules,
      rootDependencies,
      expectedGraph,
      "restored fixture",
    ),
  );

  const relocatedLeftModules = join(relocatedNodeModules, ".pnpm", "left@1.0.0", "node_modules");
  const relocatedSharedTwo = join(
    relocatedNodeModules,
    ".pnpm",
    "shared@2.0.0",
    "node_modules",
    "shared",
  );
  rmSync(join(relocatedLeftModules, "shared"), { recursive: true, force: true });
  linkDirectory(relocatedSharedTwo, join(relocatedLeftModules, "shared"));
  assert.throws(
    () =>
      assertNodeModulesGraph(
        relocatedNodeModules,
        rootDependencies,
        expectedGraph,
        "flattened fixture",
      ),
    /left@1\.0\.0\|shared\|shared@1\.0\.0/,
  );
});

test("external links require an explicit one-shot ignore", (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const selfLink = join(layout.nodeModules, ".pnpm", "node_modules", "root-package");
  linkDirectory(layout.root, selfLink);

  assert.throws(
    () => detachNodeModulesLinks(layout.nodeModules),
    /link target escapes the deploy tree/,
  );
  assert.equal(existsSync(selfLink), true);

  const result = detachNodeModulesLinks(layout.nodeModules, {
    ignoredExternalLinks: [".pnpm/node_modules/root-package"],
  });
  assert.deepEqual(result.ignoredExternalLinks, [".pnpm/node_modules/root-package"]);
  assert.equal(existsSync(selfLink), false);
});

test("restore rejects manifest path traversal before creating links", (t) => {
  const layout = fixture();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { manifest } = detachNodeModulesLinks(layout.nodeModules);
  const malicious = {
    version: 1,
    links: [
      manifest.links[0],
      { path: "../outside", target: ".pnpm/shared@1.0.0", kind: "directory" },
    ],
  };
  assert.throws(
    () => restoreNodeModulesLinks(layout.nodeModules, malicious),
    /unsafe segment|escapes node_modules/,
  );
  assert.equal(existsSync(join(layout.nodeModules, ...manifest.links[0].path.split("/"))), false);
  assert.equal(existsSync(join(layout.root, "outside")), false);
  assert.throws(
    () =>
      restoreNodeModulesLinks(layout.nodeModules, {
        version: 1,
        links: [
          { path: "overlap", target: manifest.links[0].target, kind: "directory" },
          { path: "overlap/nested", target: manifest.links[0].target, kind: "directory" },
        ],
      }),
    /link paths overlap/,
  );
  assert.match(readFileSync(join(layout.sharedOne, "package.json"), "utf8"), /shared/);
});

test("graph resolution cannot escape into an ancestor workspace node_modules", (t) => {
  const root = mkdtempSync(join(tmpdir(), "piabyss-bounded-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hostNodeModules = join(root, "apps", "host", "node_modules");
  writePackage(join(hostNodeModules, "consumer"), {
    name: "consumer",
    version: "1.0.0",
    dependencies: { leaked: "1.0.0" },
  });
  writePackage(join(root, "node_modules", "leaked"), { name: "leaked", version: "1.0.0" });

  const graph = snapshotNodeModulesGraph(hostNodeModules, { consumer: "1.0.0" });
  assert.ok(graph.edges.includes("consumer@1.0.0|leaked|<missing>"));
  assert.ok(!graph.packages.includes("leaked@1.0.0"));
});
