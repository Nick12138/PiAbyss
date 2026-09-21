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
import {
  getTransientWorkspaceView,
  resolveWorkspaceTarget,
} from "./workspace-skills-context.js";
import type { WorkspaceTargetRef } from "@piabyss/protocol";

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

/** Structural subset of a graph (or transient view) for prompt snapshots. */
type PromptSnapshotSource = Pick<
  WorkspaceGraph,
  "workspaceId" | "canonicalCwd" | "settingsManager"
>;

function buildPromptSnapshot(
  factory: WorkspaceGraphFactory,
  source: PromptSnapshotSource,
  revision: number,
): PromptSnapshot {
  const agentDir = factory.deps.agentDir;
  const cwd = source.canonicalCwd;
  const projectTrusted = source.settingsManager?.isProjectTrusted() ?? false;

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
      prompts.push({
        name: file.name,
        kind: file.kind,
        scope: "user",
        filePath,
        loaded: !shadowed,
      });
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
      prompts.push({
        name: file.name,
        kind: file.kind,
        scope: "project",
        filePath,
        loaded: projectTrusted,
      });
    }
  }

  return {
    revision,
    workspaceId: source.workspaceId,
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
      const resolved = resolveWorkspaceTarget(
        factory,
        (ctx.params ?? null) as WorkspaceTargetRef | null,
      );
      if ("code" in resolved) return { error: resolved };
      if (!resolved.isActive) {
        const staleHost = factory.checkIdentity(ctx.context, {});
        if (staleHost) return { error: staleHost };
        try {
          const view = await getTransientWorkspaceView(factory, resolved.canonicalCwd);
          return {
            result: buildPromptSnapshot(factory, view, server.identity.workspaceRevision),
            identity: server.identity.snapshot(),
          };
        } catch (error) {
          return {
            error: createHostError(
              "INTERNAL_ERROR",
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
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
          return buildPromptSnapshot(factory, g, server.identity.workspaceRevision);
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },
  };
}
