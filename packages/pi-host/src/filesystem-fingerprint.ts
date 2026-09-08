import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const OPAQUE_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

/**
 * Bumped whenever digest composition changes. Fingerprints are only ever
 * compared against ones captured by the same build, so an upgrade invalidates
 * every retained workspace once (one extra rebuild per workspace) — that is
 * the intended, safe failure mode.
 */
const FINGERPRINT_ALGORITHM = "fp-v2";

function traversalReaches(ancestor: string, candidate: string): boolean {
  const rel = relative(ancestor, candidate);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return false;
  }
  return !rel.split(/[\\/]/).some((segment) => OPAQUE_DIRECTORY_NAMES.has(segment));
}

function normalizeRoots(roots: Iterable<string>): string[] {
  const unique = [...new Set([...roots].map((root) => resolve(root)))];
  return unique
    .filter(
      (candidate) =>
        !unique.some(
          (ancestor) => ancestor !== candidate && traversalReaches(ancestor, candidate),
        ),
    )
    .sort((a, b) => a.localeCompare(b));
}

type StatOutcome =
  | { kind: "stat"; stat: Stats }
  | { kind: "missing" }
  | { kind: "error"; message: string };

async function statEntry(path: string, signal?: AbortSignal): Promise<StatOutcome> {
  try {
    const stat: Stats = await lstat(path);
    return { kind: "stat", stat };
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function statLine(root: string, label: string, outcome: StatOutcome): string {
  if (outcome.kind === "missing") return `missing:${root}:${label}\n`;
  if (outcome.kind === "error") return `error:${root}:${label}:${outcome.message}\n`;
  const { stat } = outcome;
  return `${root}:${label}|${stat.mode}|${stat.size}|${Math.trunc(stat.mtimeMs)}\n`;
}

/**
 * Deterministic digest of one subtree. Sibling stats are fetched concurrently
 * and recursion fans out across subdirectories, but digest inputs are combined
 * in sorted-entry order, so the result is stable for identical trees.
 */
async function digestDirectory(
  root: string,
  path: string,
  label: string,
  ownOutcome: StatOutcome,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  hash.update(statLine(root, label, ownOutcome));
  if (ownOutcome.kind !== "stat" || !ownOutcome.stat.isDirectory()) {
    return hash.digest("hex");
  }

  const entries = await readdir(path, { withFileTypes: true });
  signal?.throwIfAborted();
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const outcomes = await Promise.all(
    sorted.map((entry) => statEntry(join(path, entry.name), signal)),
  );

  const childDigests: Array<Promise<string>> = [];
  sorted.forEach((entry, index) => {
    const outcome = outcomes[index]!;
    const childPath = join(path, entry.name);
    const childLabel = relative(root, childPath).replace(/\\/g, "/");
    const line = statLine(root, childLabel, outcome);
    if (outcome.kind !== "stat" || !outcome.stat.isDirectory()) {
      hash.update(line);
      return;
    }
    if (OPAQUE_DIRECTORY_NAMES.has(entry.name)) {
      hash.update(`${line}opaque:${root}:${childLabel}\n`);
      return;
    }
    childDigests.push(digestDirectory(root, childPath, childLabel, outcome, signal));
  });
  for (const digest of childDigests) hash.update(await digest);
  return hash.digest("hex");
}

export async function captureFilesystemFingerprint(args: {
  roots: Iterable<string>;
  markers?: Iterable<string>;
  signal?: AbortSignal;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`${FINGERPRINT_ALGORITHM}\n`);

  for (const marker of [...(args.markers ?? [])].sort((a, b) => a.localeCompare(b))) {
    hash.update(`marker:${marker}\n`);
  }
  for (const root of normalizeRoots(args.roots)) {
    hash.update(`root:${root}\n`);
    const outcome = await statEntry(root, args.signal);
    hash.update(await digestDirectory(root, root, ".", outcome, args.signal));
  }
  args.signal?.throwIfAborted();
  return hash.digest("hex");
}
