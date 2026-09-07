import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostIdentity, PromptSnapshot } from "@piabyss/protocol";
import type { HandlerContext } from "./server.js";
import { TryMutex } from "./locks.js";
import { createPromptHandlers } from "./prompt-controller.js";
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

function fixture(
  layout: TempAgentLayout,
  trusted: boolean,
  files: { agentDir: string[]; projectDir: string[] },
) {
  for (const name of files.agentDir) {
    writeFileSync(join(layout.agentDir, name), "# global", "utf8");
  }
  mkdirSync(join(layout.projectDir, ".pi"), { recursive: true });
  for (const name of files.projectDir) {
    writeFileSync(join(layout.projectDir, ".pi", name), "# project", "utf8");
  }
  const graph = {
    canonicalCwd: layout.projectDir,
    workspaceId: identity.workspaceId,
    resourceReloadRequired: false,
    settingsManager: {
      isProjectTrusted: () => trusted,
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
  return { factory };
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

describe("prompt-controller", () => {
  let layout: TempAgentLayout;
  let handlers: ReturnType<typeof createPromptHandlers>;

  beforeEach(() => {
    layout = createTempAgentLayout("piabyss-prompt-test-");
  });

  afterEach(() => {
    layout.cleanup();
  });

  it("lists only prompt files that exist on disk, grouped by scope", async () => {
    const { factory } = fixture(
      layout,
      true,
      { agentDir: ["SYSTEM.md", "AGENTS.md"], projectDir: ["APPEND_SYSTEM.md"] },
    );
    handlers = createPromptHandlers(factory);

    const outcome = (await handlers["prompt.list"]!(context("prompt.list", null))) as {
      result?: PromptSnapshot;
      error?: { message: string };
    };
    expect(outcome.error).toBeUndefined();
    const snapshot = outcome.result!;
    expect(snapshot.cwd).toBe(layout.projectDir);
    expect(snapshot.agentDir).toBe(layout.agentDir);
    expect(snapshot.projectTrusted).toBe(true);
    // Missing files (CLAUDE.md, project SYSTEM.md/AGENTS.md) are not listed.
    expect(snapshot.prompts).toEqual([
      { name: "SYSTEM.md", kind: "system", scope: "user", filePath: join(layout.agentDir, "SYSTEM.md"), loaded: true },
      { name: "AGENTS.md", kind: "context", scope: "user", filePath: join(layout.agentDir, "AGENTS.md"), loaded: true },
      { name: "APPEND_SYSTEM.md", kind: "append", scope: "project", filePath: join(layout.projectDir, ".pi", "APPEND_SYSTEM.md"), loaded: true },
    ]);
  });

  it("shadows the global SYSTEM.md when a trusted project file overrides it", async () => {
    const { factory } = fixture(
      layout,
      true,
      { agentDir: ["SYSTEM.md", "APPEND_SYSTEM.md"], projectDir: ["SYSTEM.md"] },
    );
    handlers = createPromptHandlers(factory);

    const outcome = (await handlers["prompt.list"]!(context("prompt.list", null))) as {
      result?: PromptSnapshot;
      error?: { message: string };
    };
    const userSystem = outcome.result!.prompts.find(
      (prompt) => prompt.scope === "user" && prompt.name === "SYSTEM.md",
    );
    const projectSystem = outcome.result!.prompts.find(
      (prompt) => prompt.scope === "project" && prompt.name === "SYSTEM.md",
    );
    expect(userSystem?.loaded).toBe(false);
    expect(projectSystem?.loaded).toBe(true);
  });

  it("does not shadow the global file when the project is untrusted", async () => {
    const { factory } = fixture(
      layout,
      false,
      { agentDir: ["SYSTEM.md"], projectDir: ["SYSTEM.md"] },
    );
    handlers = createPromptHandlers(factory);

    const outcome = (await handlers["prompt.list"]!(context("prompt.list", null))) as {
      result?: PromptSnapshot;
      error?: { message: string };
    };
    const userSystem = outcome.result!.prompts.find(
      (prompt) => prompt.scope === "user" && prompt.name === "SYSTEM.md",
    );
    const projectSystem = outcome.result!.prompts.find(
      (prompt) => prompt.scope === "project" && prompt.name === "SYSTEM.md",
    );
    // Untrusted project: global stays loaded, project override does not load.
    expect(userSystem?.loaded).toBe(true);
    expect(projectSystem?.loaded).toBe(false);
  });

  it("loads context files regardless of project trust", async () => {
    for (const trusted of [true, false]) {
      const layout2 = createTempAgentLayout("piabyss-prompt-ctx-");
      try {
        const { factory } = fixture(
          layout2,
          trusted,
          { agentDir: [], projectDir: ["AGENTS.md", "CLAUDE.md"] },
        );
        const h = createPromptHandlers(factory);
        const outcome = (await h["prompt.list"]!(context("prompt.list", null))) as {
          result?: PromptSnapshot;
          error?: { message: string };
        };
        const projectContexts = outcome.result!.prompts.filter(
          (prompt) => prompt.scope === "project",
        );
        expect(projectContexts).toHaveLength(2);
        expect(projectContexts.every((prompt) => prompt.loaded)).toBe(true);
      } finally {
        layout2.cleanup();
      }
    }
  });
});
