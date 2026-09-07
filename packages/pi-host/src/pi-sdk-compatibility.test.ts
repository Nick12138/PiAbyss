import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices } from "./test-helpers/model-runtime.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(currentDir, "../../../test-fixtures/pi-agent/0.80.7");
const sourceSessionFile = join(fixtureRoot, "agent/sessions/compat-session.jsonl");
const layouts: TempAgentLayout[] = [];

afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function installFixture(): TempAgentLayout {
  const layout = createTempAgentLayout("piabyss-pi-0807-compat-");
  layouts.push(layout);
  cpSync(join(fixtureRoot, "agent"), layout.agentDir, { recursive: true, force: true });
  cpSync(join(fixtureRoot, "workspace"), layout.projectDir, { recursive: true, force: true });

  const sessionFile = join(layout.agentDir, "sessions/compat-session.jsonl");
  const escapedProjectDir = JSON.stringify(layout.projectDir).slice(1, -1);
  writeFileSync(
    sessionFile,
    readFileSync(sessionFile, "utf8").replaceAll("__PROJECT_DIR__", escapedProjectDir),
  );
  return layout;
}

describe("Pi SDK 0.80.7 compatibility fixtures", () => {
  it("loads sanitized auth, models, settings, and local package resources", async () => {
    const layout = installFixture();
    // 0.80.7 data read through the 0.82.1 runtime and the PiAbyss-owned store.
    const { credentialStore, modelRegistry } = await createTestModelServices(layout.agentDir);
    const settingsManager = SettingsManager.create(layout.projectDir, layout.agentDir, {
      projectTrusted: true,
    });

    // The store rejects on failure rather than accumulating drainable errors,
    // so a resolving read is itself the assertion that the file parsed.
    expect(await credentialStore.list()).toEqual(
      expect.arrayContaining([
        { providerId: "piabyss-fixture", type: "api_key" },
        { providerId: "piabyss-fixture-oauth", type: "oauth" },
      ]),
    );
    expect(await credentialStore.readRaw("piabyss-fixture")).toEqual({
      type: "api_key",
      key: "piabyss-fixture-api-key-never-real",
      env: { PIABYSS_FIXTURE_ACCOUNT: "piabyss-fixture-account-never-real" },
    });
    expect(await credentialStore.readRaw("piabyss-fixture-oauth")).toMatchObject({
      type: "oauth",
      refresh: "piabyss-fixture-refresh-never-real",
      access: "piabyss-fixture-access-never-real",
    });

    expect(modelRegistry.getError()).toBeUndefined();
    const model = modelRegistry.find("piabyss-fixture", "fixture-model");
    expect(model).toMatchObject({
      provider: "piabyss-fixture",
      id: "fixture-model",
      reasoning: true,
      contextWindow: 32768,
      maxTokens: 4096,
    });
    const requestAuth = await modelRegistry.getApiKeyAndHeaders(model!);
    expect(requestAuth).toEqual({
      ok: true,
      apiKey: "piabyss-fixture-api-key-never-real",
      headers: {
        "X-Fixture-Token": "piabyss-fixture-header-never-real",
        Authorization: "Bearer piabyss-fixture-api-key-never-real",
      },
      env: { PIABYSS_FIXTURE_ACCOUNT: "piabyss-fixture-account-never-real" },
    });

    expect(settingsManager.drainErrors()).toEqual([]);
    expect(settingsManager.getGlobalSettings()).toMatchObject({
      defaultProvider: "piabyss-fixture",
      defaultModel: "fixture-model",
      defaultThinkingLevel: "high",
    });
    expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
    expect(settingsManager.getPackages()).toEqual(["./packages/local-compat-package"]);

    const packageManager = new DefaultPackageManager({
      cwd: layout.projectDir,
      agentDir: layout.agentDir,
      settingsManager,
    });
    const resources = await packageManager.resolve(async (source) => {
      throw new Error(`Local fixture unexpectedly requested installation: ${source}`);
    });
    const packageRoot = join(layout.agentDir, "packages/local-compat-package");
    expect(resources.extensions.map((entry) => entry.path)).toContain(
      join(packageRoot, "extensions/compat-extension.ts"),
    );
    expect(resources.skills.map((entry) => entry.path)).toContain(
      join(packageRoot, "skills/compat-skill/SKILL.md"),
    );
    expect(resources.prompts.map((entry) => entry.path)).toContain(
      join(packageRoot, "prompts/compat-prompt.md"),
    );
    expect(resources.themes.map((entry) => entry.path)).toContain(
      join(packageRoot, "themes/compat-theme.json"),
    );
  });

  it("opens, continues, appends, and reopens a copied version 3 session", async () => {
    const sourceBefore = readFileSync(sourceSessionFile, "utf8");
    const layout = installFixture();
    const sessionDir = join(layout.agentDir, "sessions");
    const copiedSessionFile = join(sessionDir, "compat-session.jsonl");
    const copiedBefore = readFileSync(copiedSessionFile, "utf8");

    const opened = SessionManager.open(copiedSessionFile, sessionDir, layout.projectDir);
    expect(opened.getHeader()).toMatchObject({
      version: 3,
      id: "08070000-0000-4000-8000-000000000001",
      cwd: layout.projectDir,
    });
    expect(opened.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "compaction", summary: "Historical fixture summary" }),
        expect.objectContaining({
          type: "branch_summary",
          summary: "Historical fixture branch summary",
        }),
      ]),
    );
    expect(opened.buildSessionContext()).toMatchObject({
      thinkingLevel: "high",
      model: { provider: "piabyss-fixture", modelId: "fixture-model" },
    });
    expect(opened.buildSessionContext().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Keep this message after compaction" }),
      ]),
    );

    opened.appendMessage({
      role: "user",
      content: "Appended only to the copied fixture",
      timestamp: Date.now(),
    });
    const copiedAfter = readFileSync(copiedSessionFile, "utf8");
    expect(copiedAfter.length).toBeGreaterThan(copiedBefore.length);
    expect(copiedAfter).toContain("Appended only to the copied fixture");
    expect(readFileSync(sourceSessionFile, "utf8")).toBe(sourceBefore);

    const reopened = SessionManager.open(copiedSessionFile, sessionDir, layout.projectDir);
    expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "user",
      content: "Appended only to the copied fixture",
    });

    const continued = SessionManager.continueRecent(layout.projectDir, sessionDir);
    expect(continued.getSessionFile()).toBe(copiedSessionFile);
    expect(continued.getSessionId()).toBe("08070000-0000-4000-8000-000000000001");
    const listed = await SessionManager.list(layout.projectDir, sessionDir);
    expect(listed).toEqual([
      expect.objectContaining({
        path: copiedSessionFile,
        name: "Pi 0.80.7 compatibility fixture",
        firstMessage: "Historical fixture question",
      }),
    ]);
    expect(copiedSessionFile.startsWith(layout.root)).toBe(true);
  });
});
