import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolvePnpmCommand } from "./pnpm-command.mjs";

function withEnv(vars, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a JS npm_execpath is spawned through node without a shell", () => {
  const entry = "C:\\fake\\pnpm.mjs";
  const resolved = withEnv({ npm_execpath: entry }, resolvePnpmCommand);
  assert.equal(resolved.executable, process.execPath);
  assert.deepEqual(resolved.prefixArgs, [entry]);
  assert.equal(resolved.shell, false);
});

test("the .cmd shim is never handed to a shell-less spawn", () => {
  // Node cannot spawn a .cmd without a shell (EINVAL), so a .cmd npm_execpath
  // must fall through to a shell-free invocation strategy instead.
  const resolved = withEnv({ npm_execpath: "C:\\fake\\pnpm.cmd" }, resolvePnpmCommand);
  assert.equal(resolved.shell, false);
  assert.doesNotMatch(resolved.executable, /\.cmd$/iu);
  if (process.platform === "win32") {
    assert.equal(resolved.executable, process.env.ComSpec ?? "cmd.exe");
    assert.deepEqual(resolved.prefixArgs, ["/d", "/s", "/c", "pnpm"]);
  } else {
    assert.equal(resolved.executable, "pnpm");
    assert.deepEqual(resolved.prefixArgs, []);
  }
});

test("a missing npm_execpath resolves to the platform default", () => {
  const resolved = withEnv({ npm_execpath: undefined }, resolvePnpmCommand);
  assert.equal(resolved.shell, false);
  if (process.platform === "win32") {
    assert.deepEqual(resolved.prefixArgs, ["/d", "/s", "/c", "pnpm"]);
  } else {
    assert.deepEqual(resolved.prefixArgs, []);
  }
});

test("the resolved command runs pnpm without triggering DEP0190", () => {
  // The weak spot being guarded is the parent: Node emits DEP0190 to the process
  // that passes `shell: true` with an argument array. Run the real spawn in a
  // child so its stderr can be inspected for that exact warning.
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { spawnSync } from "node:child_process";',
        'import { resolvePnpmCommand } from "./scripts/pnpm-command.mjs";',
        "const { executable, prefixArgs, shell } = resolvePnpmCommand();",
        "const r = spawnSync(executable, [...prefixArgs, '--version'], {",
        "  encoding: 'utf8', windowsHide: true,",
        "});",
        "if (r.status !== 0) { console.error(r.stderr); process.exit(r.status ?? 1); }",
        "console.log(`SHELL=${shell} VERSION=${r.stdout.trim()}`);",
      ].join("\n"),
    ],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true, shell: false },
  );

  assert.equal(probe.status, 0, `probe failed: ${probe.stderr}`);
  assert.match(probe.stdout, /SHELL=false/u, `expected a shell-free spawn: ${probe.stdout}`);
  assert.match(probe.stdout, /VERSION=\d+\.\d+\.\d+/u, `unexpected output: ${probe.stdout}`);
  assert.doesNotMatch(probe.stderr, /DEP0190/u, `DEP0190 leaked: ${probe.stderr}`);
});
