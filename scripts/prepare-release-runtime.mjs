/** Stage the pinned Node runtime and platform Git strategy for a release build. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveReleaseRuntimeTarget, stagedNpmProbe } from "./release-runtime-target.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "scripts/release-runtime.lock.json");
const cacheRoot = join(root, ".runtime-cache");
const stageNode = join(root, "apps/desktop/src-tauri/resources/node");
const stageGit = join(root, "apps/desktop/src-tauri/resources/git");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const target = resolveReleaseRuntimeTarget(lock);
const nodeRuntime = target.node;

function die(message) {
  console.error("[prepare-runtime]", message);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, destination) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`[prepare-runtime] download attempt ${attempt} failed; retrying`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  die(
    `download failed ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    die(
      `${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message || `exit ${String(result.status)}`}`,
    );
  }
  return result;
}

function findFile(directory, name) {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}

function extractArchive(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      // Windows PowerShell's Expand-Archive can exit successfully without
      // materializing files on some hosted runners. Use the underlying ZIP
      // API directly so extraction and its exit status are deterministic.
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}','${destination.replace(/'/g, "''")}')`,
      ]);
    } else {
      run("unzip", ["-q", "-o", archivePath, "-d", destination]);
    }
    return;
  }
  if (archivePath.endsWith(".tar.gz")) {
    run("tar", ["-xzf", archivePath, "-C", destination]);
    return;
  }
  die(`unsupported Node archive: ${archivePath}`);
}

function stageNodeDistribution(sourceRoot, archiveSha256) {
  rmSync(stageNode, { recursive: true, force: true });
  mkdirSync(stageNode, { recursive: true });
  cpSync(sourceRoot, stageNode, { recursive: true });

  let nodeExecutable = join(stageNode, target.stagedNodeExecutable);
  let npmExecutable = join(stageNode, target.stagedNpmExecutable);
  let npxExecutable = join(stageNode, target.stagedNpxExecutable);
  if (target.platform === "darwin") {
    cpSync(join(stageNode, "bin/node"), nodeExecutable);
    const writeNodeTool = (path, cliEntry) => {
      writeFileSync(
        path,
        [
          "#!/bin/sh",
          `exec \"$(dirname \"$0\")/node\" \"$(dirname \"$0\")/${cliEntry}\" \"$@\"`,
          "",
        ].join("\n"),
      );
      chmodSync(path, 0o755);
    };
    chmodSync(nodeExecutable, 0o755);
    writeNodeTool(npmExecutable, "lib/node_modules/npm/bin/npm-cli.js");
    writeNodeTool(npxExecutable, "lib/node_modules/npm/bin/npx-cli.js");
  }

  for (const [path, label] of [
    [nodeExecutable, target.stagedNodeExecutable],
    [npmExecutable, target.stagedNpmExecutable],
    [npxExecutable, target.stagedNpxExecutable],
  ]) {
    if (!existsSync(path)) die(`staged ${label} missing`);
  }
  const nodeProbe = run(nodeExecutable, ["--version"]);
  const npmProbeCommand = stagedNpmProbe(target, stageNode);
  const npmProbe = run(npmProbeCommand.executable, npmProbeCommand.args);
  const expectedVersion = `v${nodeRuntime.version}`;
  if (nodeProbe.stdout.trim() !== expectedVersion) {
    die(`staged Node reports ${nodeProbe.stdout.trim()}, expected ${expectedVersion}`);
  }

  const metadata = {
    target: target.key,
    platform: target.platform,
    arch: target.arch,
    nodeVersion: nodeRuntime.version,
    archive: nodeRuntime.archive,
    archiveSha256,
    nodeExecutable: target.stagedNodeExecutable,
    npmExecutable: target.stagedNpmExecutable,
    npmVersion: npmProbe.stdout.trim(),
    preparedAt: new Date().toISOString(),
    usedProcessExecPath: false,
  };
  writeFileSync(join(stageNode, "RUNTIME.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log("[prepare-runtime] staged controlled Node", JSON.stringify(metadata));
}

async function preparePortableGit() {
  const portable = target.git?.portable;
  if (!portable?.url || !portable.sha256) {
    die("release-runtime lock must pin Portable Git URL and SHA-256");
  }
  const archivePath = join(cacheRoot, portable.archive);
  if (!existsSync(archivePath) || sha256File(archivePath) !== portable.sha256) {
    console.log("[prepare-runtime] downloading", portable.url);
    await download(portable.url, archivePath);
  }
  const archiveHash = sha256File(archivePath);
  if (archiveHash !== portable.sha256) {
    die(`Portable Git SHA-256 mismatch: expected ${portable.sha256} got ${archiveHash}`);
  }

  rmSync(stageGit, { recursive: true, force: true });
  mkdirSync(stageGit, { recursive: true });
  const extracted = spawnSync(archivePath, ["-y", `-o${stageGit}`], {
    cwd: cacheRoot,
    encoding: "utf8",
    shell: false,
    timeout: 300_000,
  });
  if (extracted.status !== 0) {
    die(`Portable Git extraction failed: ${extracted.stderr || extracted.stdout}`);
  }
  for (const expected of portable.expectedFiles ?? []) {
    if (!existsSync(join(stageGit, expected))) {
      die(`Portable Git missing expected staged file: ${expected}`);
    }
  }
  const gitExe = join(stageGit, "cmd", "git.exe");
  const version = run(gitExe, ["--version"], { timeout: 30_000 });
  writeFileSync(
    join(stageGit, "RUNTIME.json"),
    `${JSON.stringify(
      {
        strategy: "bundled-portable",
        target: target.key,
        gitVersion: portable.version,
        tag: portable.tag,
        archive: portable.archive,
        archiveSha256: archiveHash,
        gitExecutable: "cmd/git.exe",
        versionOutput: version.stdout.trim(),
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function prepareSystemGitEvidence() {
  const version = run("git", ["--version"], { timeout: 30_000 });
  rmSync(stageGit, { recursive: true, force: true });
  mkdirSync(stageGit, { recursive: true });
  writeFileSync(
    join(stageGit, "RUNTIME.json"),
    `${JSON.stringify(
      {
        strategy: "system-required",
        target: target.key,
        versionOutput: version.stdout.trim(),
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

mkdirSync(cacheRoot, { recursive: true });
const archivePath = join(cacheRoot, nodeRuntime.archive);
if (!existsSync(archivePath) || sha256File(archivePath) !== nodeRuntime.sha256) {
  console.log("[prepare-runtime] downloading", nodeRuntime.url);
  await download(nodeRuntime.url, archivePath);
}
const archiveSha256 = sha256File(archivePath);
if (archiveSha256 !== nodeRuntime.sha256) {
  die(`Node SHA-256 mismatch: expected ${nodeRuntime.sha256} got ${archiveSha256}`);
}

const extractRoot = join(cacheRoot, `node-${target.key}-${nodeRuntime.version}`);
const archiveExecutable = target.platform === "win32" ? "node.exe" : "node";
let sourceExecutable = findFile(extractRoot, archiveExecutable);
if (!sourceExecutable) {
  rmSync(extractRoot, { recursive: true, force: true });
  extractArchive(archivePath, extractRoot);
  sourceExecutable = findFile(extractRoot, archiveExecutable);
}
if (!sourceExecutable)
  die(`${archiveExecutable} not found after extracting ${nodeRuntime.archive}`);
const sourceRoot =
  target.platform === "win32" ? dirname(sourceExecutable) : dirname(dirname(sourceExecutable));
for (const expected of nodeRuntime.expectedFiles ?? []) {
  if (!existsSync(join(sourceRoot, expected))) {
    die(`Node archive missing expected file: ${expected}`);
  }
}
stageNodeDistribution(sourceRoot, archiveSha256);

if (target.git?.strategy === "bundled-portable") {
  await preparePortableGit();
} else if (target.git?.strategy === "system-required") {
  prepareSystemGitEvidence();
} else {
  die(`unsupported Git runtime strategy: ${target.git?.strategy ?? "missing"}`);
}

console.log(`[prepare-runtime] OK target=${target.key}`);
