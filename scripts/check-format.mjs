import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import prettier from "prettier";

const FORMATTED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const IGNORED_PATH_PREFIXES = [
  "apps/desktop/src-tauri/gen/",
  "apps/desktop/src-tauri/resources/",
  "artifacts/",
];
const write = process.argv.includes("--write");

function gitLines(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (allowFailure) {
      return [];
    }
    throw error;
  }
}

function changedFiles() {
  const files = new Set([
    ...gitLines(["diff", "--name-only", "--diff-filter=ACMR"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]);
  const base = process.env.PIABYSS_FORMAT_BASE?.trim();
  const usableBase = base && !/^0+$/u.test(base) ? base : null;
  if (usableBase) {
    for (const file of gitLines([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      `${usableBase}...HEAD`,
    ])) {
      files.add(file);
    }
  } else if (files.size === 0) {
    for (const file of gitLines(["diff", "--name-only", "--diff-filter=ACMR", "HEAD^", "HEAD"], {
      allowFailure: true,
    })) {
      files.add(file);
    }
  }
  return [...files];
}

function isMaintainedFormatTarget(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    FORMATTED_EXTENSIONS.has(path.extname(normalized).toLowerCase()) &&
    normalized !== "pnpm-lock.yaml" &&
    !IGNORED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

const files = changedFiles().filter(isMaintainedFormatTarget).sort();
if (files.length === 0) {
  console.log("No changed format targets.");
  process.exit(0);
}

const invalid = [];
await Promise.all(
  files.map(async (file) => {
    const source = await readFile(file, "utf8");
    const options = (await prettier.resolveConfig(file)) ?? {};
    const prettierOptions = { ...options, filepath: file };
    if (write) {
      const formatted = await prettier.format(source, prettierOptions);
      if (formatted !== source) {
        await writeFile(file, formatted, "utf8");
      }
    } else if (!(await prettier.check(source, prettierOptions))) {
      invalid.push(file);
    }
  }),
);

if (write) {
  console.log(`Prettier formatted ${files.length} changed file(s).`);
  process.exit(0);
}

if (invalid.length > 0) {
  console.error("Changed files with Prettier differences:");
  for (const file of invalid.sort()) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

console.log(`Prettier check passed for ${files.length} changed file(s).`);
