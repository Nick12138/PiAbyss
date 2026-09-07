import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "test-fixtures/pi-agent");
const safeCredentialPattern = /^piabyss-fixture-[a-z0-9-]+-never-real$/i;
const sensitiveFieldPattern =
  /^(?:key|apiKey|access|accessToken|refresh|refreshToken|token|secret|password|authorization)$/i;
const forbiddenTokenPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function inspectSensitiveFields(value, file, path = "root") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectSensitiveFields(item, file, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (
      sensitiveFieldPattern.test(key) &&
      typeof item === "string" &&
      !safeCredentialPattern.test(item)
    ) {
      throw new Error(`${file}: ${itemPath} is not an obvious fixture credential placeholder`);
    }
    inspectSensitiveFields(item, file, itemPath);
  }
}

function parseStructuredFixture(file, content) {
  if (extname(file) === ".json") return [JSON.parse(content)];
  if (extname(file) === ".jsonl") {
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  return [];
}

if (!statSync(fixtureRoot).isDirectory()) {
  throw new Error(`Missing Pi agent fixture directory: ${fixtureRoot}`);
}

const files = walkFiles(fixtureRoot);
if (files.length === 0) throw new Error(`No Pi agent fixtures found under ${fixtureRoot}`);

for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pattern of forbiddenTokenPatterns) {
    if (pattern.test(content))
      throw new Error(`${file}: matched forbidden secret pattern ${pattern}`);
  }
  for (const value of parseStructuredFixture(file, content)) {
    inspectSensitiveFields(value, file);
  }
}

console.log(`Pi agent fixture secret scan passed (${files.length} files).`);
