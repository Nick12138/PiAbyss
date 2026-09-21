import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostIdentity } from "@piabyss/protocol";
import { createHostError } from "@piabyss/protocol";
import type { HandlerContext } from "./server.js";
import { TryMutex } from "./locks.js";
import { createSkillHandlers } from "./skill-controller.js";
import {
  buildFreshTransientWorkspaceView,
  resolveWorkspaceTarget,
  withTransientWorkspaceLock,
} from "./workspace-skills-context.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";

const identity: HostIdentity = {
  hostInstanceId: "00000000-0000-4000-8000-000000000111",
  workspaceId: "00000000-0000-4000-8000-000000000211",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
};

const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000212";
const ACTIVE_WORKSPACE_ID = identity.workspaceId as string;

type SkillHandlerResponse = {
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  };
};

function fixture(
  layout: TempAgentLayout,
  otherDir: string | null,
  overrides: {
    hasAnyBusySessions?: () => boolean;
    /** When set, findBoundGraph resolves to this fake bound graph. */
    targetGraph?: {
      workspaceId: string;
      canonicalCwd: string;
      isGraphBusy: () => boolean;
      isGraphTransitioning: () => boolean;
    };
  } = {},
) {
  const graph = {
    canonicalCwd: pathResolve(layout.projectDir),
    workspaceId: identity.workspaceId,
    resourceReloadRequired: false,
    settingsManager: { isProjectTrusted: () => true },
    resourceLoader: null,
    packageManager: null,
  };
  const server = {
    serviceGraphLock: new TryMutex(),
    identity: {
      snapshot: () => ({ ...identity }),
      workspaceRevision: identity.workspaceRevision,
      packageRevision: identity.packageRevision,
    },
  };
  const boundWorkspaces = [
    { workspaceId: identity.workspaceId, revision: 1, cwd: pathResolve(layout.projectDir) },
    ...(otherDir
      ? [{ workspaceId: OTHER_WORKSPACE_ID, revision: 1, cwd: pathResolve(otherDir) }]
      : []),
  ];
  const factory = {
    getGraph: () => graph,
    getServer: () => server,
    checkIdentity: vi.fn(() => null),
    buildBoundWorkspaces: () => boundWorkspaces,
    findBoundGraph: () => overrides.targetGraph ?? null,
    isGraphBusy: (graph: { isGraphBusy: () => boolean }) => graph.isGraphBusy(),
    isGraphTransitioning: (graph: { isGraphTransitioning: () => boolean }) =>
      graph.isGraphTransitioning(),
    canonicalizeCwd: (cwd: string) => {
      // Mirror the real lifecycle: missing directories throw a HostError.
      const resolved = pathResolve(cwd);
      if (!existsSync(resolved)) {
        throw createHostError("WORKSPACE_SWITCH_FAILED", `Directory does not exist: ${resolved}`);
      }
      return resolved;
    },
    hasAnyBusySessions: overrides.hasAnyBusySessions ?? (() => false),
    deps: { agentDir: layout.agentDir, packageUpdateCheck: false },
  } as unknown as WorkspaceGraphFactory;
  return { factory };
}

function context(method: string, params: unknown): HandlerContext {
  return {
    id: "00000000-0000-4000-8000-000000000311",
    method,
    params,
    context: {
      expectedHostInstanceId: identity.hostInstanceId,
      expectedWorkspaceId: identity.workspaceId,
      expectedWorkspaceRevision: identity.workspaceRevision,
    },
  } as unknown as HandlerContext;
}

describe("workspace-skills-context", () => {
  let layout: TempAgentLayout;
  let other: TempAgentLayout;

  beforeEach(() => {
    layout = createTempAgentLayout("piabyss-wsctx-active-");
    other = createTempAgentLayout("piabyss-wsctx-other-");
  });

  afterEach(() => {
    layout.cleanup();
    other.cleanup();
  });

  describe("resolveWorkspaceTarget", () => {
    it("treats missing target fields as the active workspace", () => {
      const { factory } = fixture(layout, other.projectDir);
      expect(resolveWorkspaceTarget(factory, null)).toEqual({ isActive: true });
      expect(resolveWorkspaceTarget(factory, {})).toEqual({ isActive: true });
    });

    it("resolves a bound non-active workspace by id and by cwd", () => {
      const { factory } = fixture(layout, other.projectDir);
      const byId = resolveWorkspaceTarget(factory, { targetWorkspaceId: OTHER_WORKSPACE_ID });
      expect(byId).toEqual({
        isActive: false,
        canonicalCwd: pathResolve(other.projectDir),
        workspaceId: OTHER_WORKSPACE_ID,
      });
      const byCwd = resolveWorkspaceTarget(factory, { targetWorkspaceCwd: other.projectDir });
      expect(byCwd).toEqual({
        isActive: false,
        canonicalCwd: pathResolve(other.projectDir),
        workspaceId: OTHER_WORKSPACE_ID,
      });
    });

    it("resolves the active workspace's own id/cwd to the active path", () => {
      const { factory } = fixture(layout, other.projectDir);
      expect(resolveWorkspaceTarget(factory, { targetWorkspaceId: ACTIVE_WORKSPACE_ID })).toEqual(
        { isActive: true },
      );
      expect(resolveWorkspaceTarget(factory, { targetWorkspaceCwd: layout.projectDir })).toEqual({
        isActive: true,
      });
    });

    it("rejects an unknown workspace id", () => {
      const { factory } = fixture(layout, other.projectDir);
      const resolved = resolveWorkspaceTarget(factory, {
        targetWorkspaceId: "00000000-0000-4000-8000-000000000999",
      });
      expect("code" in resolved && resolved.code).toBe("INVALID_REQUEST");
    });
  });

  describe("transient lock", () => {
    it("nested fresh build inside the lock does not deadlock", async () => {
      const { factory } = fixture(layout, other.projectDir);
      mkdirSync(join(other.projectDir, ".pi", "skills"), { recursive: true });
      const result = await withTransientWorkspaceLock(async () => {
        // Regression: this exact call shape used to self-deadlock when
        // buildFreshTransientWorkspaceView acquired the lock itself.
        const view = await buildFreshTransientWorkspaceView(
          factory,
          pathResolve(other.projectDir),
        );
        return view.workspaceId;
      });
      expect(result).toBe(OTHER_WORKSPACE_ID);
    });
  });

  describe("cross-workspace skill.list", () => {
    it("serves the target workspace's skills from a transient context", async () => {
      const skillDir = join(other.projectDir, ".pi", "skills", "cross");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: cross\ndescription: Cross-workspace skill\n---\n\nBody.\n",
        "utf8",
      );
      const { factory } = fixture(layout, other.projectDir);
      const handlers = createSkillHandlers(factory);
      const response = (await handlers["skill.list"]!(
        context("skill.list", { targetWorkspaceCwd: other.projectDir }),
      )) as SkillHandlerResponse;
      expect(response.error).toBeUndefined();
      const snapshot = response.result as { cwd: string; skills: Array<{ name: string }> };
      expect(snapshot.cwd).toBe(pathResolve(other.projectDir));
      expect(snapshot.skills.some((skill) => skill.name === "cross")).toBe(true);
    });

    it("rejects a target cwd that does not exist", async () => {
      const { factory } = fixture(layout, null);
      const handlers = createSkillHandlers(factory);
      const response = (await handlers["skill.list"]!(
        context("skill.list", { targetWorkspaceCwd: join(other.root, "missing") }),
      )) as SkillHandlerResponse;
      expect(response.error?.code).toBe("WORKSPACE_SWITCH_FAILED");
    });

    it("writes a project-scope skill directory into the target workspace's settings", async () => {
      const { factory } = fixture(layout, other.projectDir);
      const handlers = createSkillHandlers(factory);
      const response = (await handlers["skill.addPath"]!(
        context("skill.addPath", {
          path: "C:/team/skills",
          scope: "project",
          targetWorkspaceCwd: other.projectDir,
        }),
      )) as SkillHandlerResponse;
      expect(response.error).toBeUndefined();
      const settings = JSON.parse(
        readFileSync(join(other.projectDir, ".pi", "settings.json"), "utf8") as string,
      ) as { skills?: string[] };
      expect(settings.skills).toEqual(["C:/team/skills"]);
      // The active workspace's settings stay untouched.
      expect(existsSync(join(layout.projectDir, ".pi", "settings.json"))).toBe(false);
      // The returned snapshot belongs to the target workspace.
      const snapshot = response.result as { cwd: string };
      expect(snapshot.cwd).toBe(pathResolve(other.projectDir));
    });

    it("removes the path again and leaves no stale entry", async () => {
      const { factory } = fixture(layout, other.projectDir);
      const handlers = createSkillHandlers(factory);
      await handlers["skill.addPath"]!(
        context("skill.addPath", {
          path: "C:/team/skills",
          scope: "project",
          targetWorkspaceCwd: other.projectDir,
        }),
      );
      const response = (await handlers["skill.removePath"]!(
        context("skill.removePath", {
          path: "C:/team/skills",
          scope: "project",
          targetWorkspaceCwd: other.projectDir,
        }),
      )) as SkillHandlerResponse;
      expect(response.error).toBeUndefined();
      const settings = JSON.parse(
        readFileSync(join(other.projectDir, ".pi", "settings.json"), "utf8") as string,
      ) as { skills?: string[] };
      expect(settings.skills).toEqual([]);
    });

    it("allows cross-workspace mutations while ANOTHER workspace has a busy session", async () => {
      // Regression: the legacy host-wide gate refused cross-workspace skill
      // mutations whenever any session was running anywhere (e.g. in the
      // active workspace), even though the target workspace is untouched.
      const { factory } = fixture(layout, other.projectDir, {
        hasAnyBusySessions: () => true,
      });
      const handlers = createSkillHandlers(factory);
      const response = (await handlers["skill.removePath"]!(
        context("skill.removePath", {
          path: "C:/team/skills",
          scope: "project",
          targetWorkspaceCwd: other.projectDir,
        }),
      )) as SkillHandlerResponse;
      expect(response.error).toBeUndefined();
    });

    it("refuses with AGENT_BUSY when the target workspace itself has a busy session", async () => {
      const { factory } = fixture(layout, other.projectDir, {
        targetGraph: {
          workspaceId: OTHER_WORKSPACE_ID,
          canonicalCwd: pathResolve(other.projectDir),
          isGraphBusy: () => true,
          isGraphTransitioning: () => false,
        },
      });
      const handlers = createSkillHandlers(factory);
      const response = (await handlers["skill.removePath"]!(
        context("skill.removePath", {
          path: "C:/team/skills",
          scope: "project",
          targetWorkspaceCwd: other.projectDir,
        }),
      )) as SkillHandlerResponse;
      expect(response.error?.code).toBe("AGENT_BUSY");
      expect(response.error?.retryable).toBe(true);
      expect(response.error?.details).toEqual({
        workspaceId: OTHER_WORKSPACE_ID,
        cwd: pathResolve(other.projectDir),
      });
      // The settings file was not created or modified.
      expect(existsSync(join(other.projectDir, ".pi", "settings.json"))).toBe(false);
    });

    it("refuses with a retryable error while the target workspace is switching state", async () => {
      const { factory } = fixture(layout, other.projectDir, {
        targetGraph: {
          workspaceId: OTHER_WORKSPACE_ID,
          canonicalCwd: pathResolve(other.projectDir),
          isGraphBusy: () => false,
          isGraphTransitioning: () => true,
        },
      });
      const handlers = createSkillHandlers(factory);
      const response = (await handlers["skill.addPath"]!(
        context("skill.addPath", {
          path: "C:/team/skills",
          scope: "project",
          targetWorkspaceCwd: other.projectDir,
        }),
      )) as SkillHandlerResponse;
      expect(response.error?.code).toBe("SERVICE_GRAPH_BUSY");
      expect(response.error?.retryable).toBe(true);
    });
  });
});
