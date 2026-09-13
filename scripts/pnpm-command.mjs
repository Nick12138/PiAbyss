/**
 * Resolve how to spawn the package manager from inside a `pnpm run` script.
 *
 * Windows cannot spawn a `.cmd` shim without a shell (`spawnSync("pnpm", …,
 * { shell: false })` fails with `EINVAL`), and the historical workaround —
 * `{ shell: true }` — triggers Node's `DEP0190` warning because the argument
 * array is concatenated into a command line instead of being escaped. When the
 * script is launched through `pnpm run`, `npm_execpath` points at pnpm's own
 * `pnpm.mjs`, so the generic Node fallback is available and needs no shell.
 *
 * Resolution order:
 *   1. `npm_execpath` pointing at a JS entry (`pnpm.mjs`/`.cjs`) → `node <entry>`.
 *      This is the path release scripts take via `pnpm package:release`.
 *   2. Windows → the explicit `cmd.exe /d /s /c` form, which keeps the argument
 *      vector separated and therefore needs no `shell: true`.
 *   3. Elsewhere → the bare `pnpm` binary resolved through `PATH`.
 *
 * @returns spawn-ready command plus whether `shell: true` is still required.
 */
export function resolvePnpmCommand() {
  const execPath = process.env.npm_execpath?.trim();
  // A non-JS `npm_execpath` (the `.cmd` shim) is unusable without a shell;
  // fall through to the platform defaults in that case.
  if (execPath && /\.(?:c?js|mjs)$/iu.test(execPath)) {
    return { executable: process.execPath, prefixArgs: [execPath], shell: false };
  }
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "pnpm"],
      shell: false,
    };
  }
  return { executable: "pnpm", prefixArgs: [], shell: false };
}
