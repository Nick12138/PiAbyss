import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostIdentity, SkillSnapshot } from "@piabyss/protocol";
import type { Skill, ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { HandlerContext } from "./server.js";
import { TryMutex } from "./locks.js";
import { createSkillHandlers } from "./skill-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";

const identity: HostIdentity = {
  hostInstanceId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000201",
  workspaceRevision: 3,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
};

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "example",
    description: "Example skill",
    filePath: "/skills/example/SKILL.md",
    baseDir: "/skills/example",
    sourceInfo: {
      path: "/skills/example",
      source: "user",
      scope: "user",
      origin: "top-level",
    },
    disableModelInvocation: false,
    ...overrides,
  };
}

function fixture(layout: TempAgentLayout, skills: Skill[] = []) {
  const graph = {
    canonicalCwd: layout.projectDir,
    workspaceId: identity.workspaceId,
    resourceReloadRequired: false,
    settingsManager: {
      isProjectTrusted: () => true,
      reload: vi.fn(async () => undefined),
    },
    packageManager: {
      listConfiguredPackages: () => [],
      getInstalledPath: () => undefined,
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
    },
    packageSnapshot: null,
    resourceIdMap: new Map(),
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: (): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } => ({
        skills,
        diagnostics: [],
      }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      reload: vi.fn(async () => undefined),
    },
  };
  const server = {
    serviceGraphLock: new TryMutex(),
    identity: {
      snapshot: () => ({ ...identity }),
      workspaceRevision: identity.workspaceRevision,
      packageRevision: identity.packageRevision,
    },
  };
  const factory = {
    getGraph: () => graph,
    getServer: () => server,
    checkIdentity: vi.fn(() => null),
    deps: { agentDir: layout.agentDir, packageUpdateCheck: false },
  } as unknown as WorkspaceGraphFactory;
  return { factory, graph };
}

function context(method: string, params: unknown): HandlerContext {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    method,
    params,
    context: {
      expectedHostInstanceId: identity.hostInstanceId,
      expectedWorkspaceId: identity.workspaceId,
      expectedWorkspaceRevision: identity.workspaceRevision,
    },
  } as unknown as HandlerContext;
}

describe("skill-controller", () => {
  let layout: TempAgentLayout;
  let handlers: ReturnType<typeof createSkillHandlers>;

  beforeEach(() => {
    layout = createTempAgentLayout("piabyss-skill-test-");
  });

  afterEach(() => {
    layout.cleanup();
  });

  it("lists loaded skills and settings-configured paths", async () => {
    writeFileSync(
      join(layout.agentDir, "settings.json"),
      JSON.stringify({ skills: ["./extra-skills", "~/skills"] }, null, 2),
    );
    mkdirSync(join(layout.agentDir, "extra-skills"), { recursive: true });

    const { factory } = fixture(layout, [makeSkill()]);
    handlers = createSkillHandlers(factory);

    const outcome = (await handlers["skill.list"]!(context("skill.list", null))) as {
      result?: SkillSnapshot;
      error?: { message: string };
    };
    expect(outcome.error).toBeUndefined();
    const snapshot = outcome.result!;
    expect(snapshot.projectTrusted).toBe(true);
    expect(snapshot.cwd).toBe(layout.projectDir);
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({
      name: "example",
      scope: "user",
      origin: "top-level",
    });
    expect(snapshot.configuredPaths).toEqual([
      { path: "./extra-skills", scope: "user", exists: true },
      { path: "~/skills", scope: "user", exists: false },
    ]);
  });

  it("hides resource-preference patterns from configured paths", async () => {
    // Regression: disabling a skill writes a `-<path>` exclusion pattern into
    // the settings skills array. It is not a path, so it must not surface in
    // configuredPaths as a missing path (e.g. the WPS cloud drive case).
    const skillPath = join(layout.agentDir, "extra-skills");
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(layout.agentDir, "settings.json"),
      JSON.stringify(
        {
          skills: [
            "./extra-skills",
            `-${skillPath.replace(/\\/g, "/")}/example/SKILL.md`,
            `+${skillPath.replace(/\\/g, "/")}/other/SKILL.md`,
            `!${skillPath.replace(/\\/g, "/")}/blocked/SKILL.md`,
          ],
        },
        null,
        2,
      ),
    );

    const { factory } = fixture(layout);
    handlers = createSkillHandlers(factory);

    const outcome = (await handlers["skill.list"]!(context("skill.list", null))) as {
      result?: SkillSnapshot;
      error?: { message: string };
    };
    expect(outcome.error).toBeUndefined();
    expect(outcome.result!.configuredPaths).toEqual([
      { path: "./extra-skills", scope: "user", exists: true },
    ]);
  });

  it("adds a user-scope skill path and dedupes repeats", async () => {
    const { factory } = fixture(layout);
    handlers = createSkillHandlers(factory);

    const added = (await handlers["skill.addPath"]!(
      context("skill.addPath", { path: "../other/skills", scope: "user" }),
    )) as { result?: SkillSnapshot; error?: { message: string } };
    expect(added.error).toBeUndefined();
    expect(added.result!.configuredPaths).toEqual([
      { path: "../other/skills", scope: "user", exists: false },
    ]);

    await handlers["skill.addPath"]!(
      context("skill.addPath", { path: "../other/skills", scope: "user" }),
    );
    const settings = JSON.parse(readFileSync(join(layout.agentDir, "settings.json"), "utf8"));
    expect(settings.skills).toEqual(["../other/skills"]);
  });

  it("adds and removes project-scope skill paths in <cwd>/.pi/settings.json", async () => {
    const { factory } = fixture(layout);
    handlers = createSkillHandlers(factory);

    const added = (await handlers["skill.addPath"]!(
      context("skill.addPath", { path: "../.claude/skills", scope: "project" }),
    )) as { result?: SkillSnapshot; error?: { message: string } };
    expect(added.error).toBeUndefined();
    expect(added.result!.configuredPaths).toEqual([
      { path: "../.claude/skills", scope: "project", exists: false },
    ]);

    const projectSettings = join(layout.projectDir, ".pi", "settings.json");
    expect(existsSync(projectSettings)).toBe(true);

    const removed = (await handlers["skill.removePath"]!(
      context("skill.removePath", { path: "../.claude/skills", scope: "project" }),
    )) as { result?: SkillSnapshot; error?: { message: string } };
    expect(removed.error).toBeUndefined();
    expect(removed.result!.configuredPaths).toEqual([]);
    const settings = JSON.parse(readFileSync(projectSettings, "utf8"));
    expect(settings.skills).toEqual([]);
  });

  it("flags resourceReloadRequired when the live reload fails", async () => {
    const { factory, graph } = fixture(layout);
    graph.resourceLoader.reload = vi.fn(async () => {
      throw new Error("boom");
    });
    handlers = createSkillHandlers(factory);

    const outcome = (await handlers["skill.addPath"]!(
      context("skill.addPath", { path: "./skills", scope: "user" }),
    )) as { result?: SkillSnapshot; error?: { message: string } };
    expect(outcome.error).toBeUndefined();
    expect(outcome.result!.resourceReloadRequired).toBe(true);
    expect(graph.resourceReloadRequired).toBe(true);
  });

  it("rebuilds the canonical resource ID map so newly added skills are toggleable", async () => {
    // Regression: after adding a skill directory (e.g. a WPS cloud drive
    // folder), resource.setPreference resolved against the stale canonical
    // resourceIdMap and failed with "Resource not found: res_...".
    const wpsSkill = makeSkill({
      name: "bid-origin-check",
      filePath: "/wps/云盘/.claude/skills/bid-origin-check/SKILL.md",
      baseDir: "/wps/云盘/.claude/skills/bid-origin-check",
      sourceInfo: {
        path: "/wps/云盘/.claude/skills/bid-origin-check",
        source: "/wps/云盘/.claude/skills",
        scope: "project",
        origin: "top-level",
      },
    });
    const { factory, graph } = fixture(layout, [wpsSkill]);
    handlers = createSkillHandlers(factory);

    expect(graph.resourceIdMap.size).toBe(0);
    const added = (await handlers["skill.addPath"]!(
      context("skill.addPath", { path: "../.claude/skills", scope: "project" }),
    )) as { result?: SkillSnapshot; error?: { message: string } };
    expect(added.error).toBeUndefined();

    // The canonical map must now contain the skill resource discovered by the
    // reloaded loader, keyed by its stable res_... id.
    expect(graph.resourceIdMap.size).toBeGreaterThan(0);
    const skillResource = [...graph.resourceIdMap.values()].find(
      (metadata) => metadata.type === "skill" && metadata.path.endsWith("SKILL.md"),
    );
    expect(skillResource).toBeDefined();
    expect(skillResource!.scope).toBe("project");
    expect([...graph.resourceIdMap.keys()].some((id) => id.startsWith("res_"))).toBe(true);
    // The rebuilt package snapshot is attached to the graph for future reads.
    expect(graph.packageSnapshot).not.toBeNull();
  });

  it("suppresses skill-name validation diagnostics from the snapshot", async () => {
    // A directory like `baidu_ocr` fails Pi's slug name validation; the
    // resulting messages are noise for directory-based skills and must not
    // surface in the UI diagnostics list.
    const { factory, graph } = fixture(layout, [makeSkill()]);
    graph.resourceLoader.getSkills = () => ({
      skills: [makeSkill()],
      diagnostics: [
        {
          type: "warning" as const,
          message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
          path: "/wps/baidu_ocr/SKILL.md",
        },
        {
          type: "warning" as const,
          message: "name exceeds 50 characters (60)",
          path: "/skills/very-long-name/SKILL.md",
        },
        {
          type: "warning" as const,
          message: "name must not start or end with a hyphen",
          path: "/skills/example-/SKILL.md",
        },
        {
          type: "error" as const,
          message: "skill file not found",
          path: "/skills/missing/SKILL.md",
        },
      ],
    });
    handlers = createSkillHandlers(factory);

    const outcome = (await handlers["skill.list"]!(context("skill.list", null))) as {
      result?: SkillSnapshot;
    };
    expect(outcome.result!.diagnostics).toEqual([
      { severity: "error", message: "skill file not found", path: "/skills/missing/SKILL.md" },
    ]);
  });
});
