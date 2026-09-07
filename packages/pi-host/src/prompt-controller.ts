import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createHostError,
  type PromptInfo,
  type PromptKind,
  type PromptSnapshot,
} from "@piabyss/protocol";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import type { MethodHandler } from "./server.js";

interface ScannedPrompt {
  name: string;
  kind: PromptKind;
  fileName: string;
}

const PROMPT_FILES: ScannedPrompt[] = [
  { name: "SYSTEM.md", kind: "system", fileName: "SYSTEM.md" },
  { name: "APPEND_SYSTEM.md", kind: "append", fileName: "APPEND_SYSTEM.md" },
  { name: "AGENTS.md", kind: "context", fileName: "AGENTS.md" },
  { name: "CLAUDE.md", kind: "context", fileName: "CLAUDE.md" },
];

function buildPromptSnapshot(
  factory: WorkspaceGraphFactory,
  g: WorkspaceGraph,
  revision: number,
  workspaceId: string,
): PromptSnapshot {
  const agentDir = factory.deps.agentDir;
  const cwd = g.canonicalCwd;
  const projectTrusted = g.settingsManager?.isProjectTrusted() ?? false;

  // Precompute which project-side system/append override files exist, since a
  // project file (when trusted) shadows the global one.
  const projectOverrides: Record<string, boolean> = {};
  for (const file of PROMPT_FILES) {
    if (file.kind !== "context") {
      projectOverrides[file.fileName] = existsSync(join(cwd, ".pi", file.fileName));
    }
  }

  const prompts: PromptInfo[] = [];

  // 全局 (user scope): ~/.pi/agent/
  for (const file of PROMPT_FILES) {
    const filePath = join(agentDir, file.fileName);
    if (!existsSync(filePath)) continue;
    if (file.kind === "context") {
      // Context files (AGENTS.md/CLAUDE.md) are merged from both scopes and
      // are not trust-gated in the SDK.
      prompts.push({ name: file.name, kind: file.kind, scope: "user", filePath, loaded: true });
    } else {
      // system/append: the global file is shadowed by a trusted project file.
      const shadowed = projectTrusted && projectOverrides[file.fileName] === true;
      prompts.push({ name: file.name, kind: file.kind, scope: "user", filePath, loaded: !shadowed });
    }
  }

  // 项目 (project scope): <cwd>/.pi/
  for (const file of PROMPT_FILES) {
    const filePath = join(cwd, ".pi", file.fileName);
    if (!existsSync(filePath)) continue;
    if (file.kind === "context") {
      // Context files load regardless of trust.
      prompts.push({ name: file.name, kind: file.kind, scope: "project", filePath, loaded: true });
    } else {
      // system/append: project files only load when the workspace is trusted.
      prompts.push({ name: file.name, kind: file.kind, scope: "project", filePath, loaded: projectTrusted });
    }
  }

  return {
    revision,
    workspaceId,
    cwd,
    agentDir,
    projectTrusted,
    prompts,
  };
}

export function createPromptHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "prompt.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g) {
            throw new Error("Workspace services not ready");
          }
          return buildPromptSnapshot(factory, g, server.identity.workspaceRevision, g.workspaceId);
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },
  };
}