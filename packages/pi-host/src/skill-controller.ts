import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createHostError,
  type SkillConfiguredPath,
  type SkillInfo,
  type SkillPathMutation,
  type SkillSnapshot,
} from "@piabyss/protocol";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import type { MethodHandler } from "./server.js";
import { logger } from "./logger.js";

function globalSettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function readSettingsObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readSkillEntries(path: string): string[] {
  const settings = readSettingsObject(path);
  const skills = settings.skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Settings `skills` entries are paths or resource-preference patterns
 * (`-`/`+`/`!` prefixes written by the skill toggles). Only plain paths are
 * user-facing directory entries; patterns must not surface in the configured
 * paths list as "missing paths" (e.g. `-D:/.../SKILL.md` would show as
 * `exists=false` and mislead the user into thinking a path is broken).
 */
function isSkillPatternEntry(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function writeSkillEntries(path: string, entries: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = readSettingsObject(path);
  const next = { ...current, skills: entries };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/**
 * Resolve a configured skill path the way Pi's settings do: "~" expands to the
 * home directory and relative paths resolve against the settings file's
 * directory (the agent dir for user settings, `<cwd>/.pi` for project settings).
 */
function resolveConfiguredPath(settingsDir: string, entry: string): string {
  if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")) {
    return resolve(join(homedir(), entry.slice(1)));
  }
  return isAbsolute(entry) ? entry : resolve(settingsDir, entry);
}

function toSkillInfo(skill: Skill): SkillInfo {
  const info: SkillInfo = {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope,
    origin: skill.sourceInfo.origin,
    disableModelInvocation: skill.disableModelInvocation,
  };
  if (skill.sourceInfo.origin === "package") {
    info.packagePath = skill.sourceInfo.path;
  }
  return info;
}

function collectConfiguredPaths(agentDir: string, cwd: string): SkillConfiguredPath[] {
  const result: SkillConfiguredPath[] = [];
  const userEntries = readSkillEntries(globalSettingsPath(agentDir));
  for (const entry of userEntries) {
    if (isSkillPatternEntry(entry)) continue;
    result.push({
      path: entry,
      scope: "user",
      exists: existsSync(resolveConfiguredPath(agentDir, entry)),
    });
  }
  const projectSettingsDir = join(cwd, ".pi");
  const projectEntries = readSkillEntries(projectSettingsPath(cwd));
  for (const entry of projectEntries) {
    if (isSkillPatternEntry(entry)) continue;
    result.push({
      path: entry,
      scope: "project",
      exists: existsSync(resolveConfiguredPath(projectSettingsDir, entry)),
    });
  }
  return result;
}

/**
 * Diagnostics emitted by Pi's skill-name validation (e.g. a directory named
 * with underscores like `baidu_ocr`). Directory-based skills legitimately
 * deviate from the slug convention, so these name messages are suppressed
 * from the snapshot instead of surfacing as warnings in the UI.
 */
function isNameValidationDiagnostic(diagnostic: { message: string }): boolean {
  return (
    diagnostic.message.startsWith("name contains invalid characters") ||
    diagnostic.message.startsWith("name exceeds ") ||
    diagnostic.message.startsWith("name must not start or end with a hyphen")
  );
}

function buildSkillSnapshot(
  factory: WorkspaceGraphFactory,
  g: WorkspaceGraph,
  revision: number,
  workspaceId: string,
): SkillSnapshot {
  const loaded = g.resourceLoader?.getSkills() ?? { skills: [], diagnostics: [] };
  return {
    revision,
    workspaceId,
    cwd: g.canonicalCwd,
    projectTrusted: g.settingsManager?.isProjectTrusted() ?? false,
    skills: loaded.skills.map(toSkillInfo),
    diagnostics: loaded.diagnostics
      .filter((diagnostic) => !isNameValidationDiagnostic(diagnostic))
      .map((diagnostic) => {
        const entry: SkillSnapshot["diagnostics"][number] = {
          severity: diagnostic.type,
          message: diagnostic.message,
        };
        if (diagnostic.path !== undefined) entry.path = diagnostic.path;
        return entry;
      }),
    configuredPaths: collectConfiguredPaths(factory.deps.agentDir, g.canonicalCwd),
    resourceReloadRequired: g.resourceReloadRequired === true,
  };
}

async function mutateSkillPaths(
  factory: WorkspaceGraphFactory,
  ctx: Parameters<MethodHandler>[0],
  action: "add" | "remove",
): ReturnType<MethodHandler> {
  const server = factory.getServer();
  if (!server) {
    return { error: createHostError("HOST_NOT_READY", "Server not bound") };
  }
  const params = ctx.params as SkillPathMutation;
  const { withStableGraphRead } = await import("./stable-graph-read.js");
  const out = await withStableGraphRead({
    requestId: ctx.id,
    identity: server.identity,
    serviceGraphLock: server.serviceGraphLock,
    lockTimeoutMs: 5_000,
    precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
    run: async () => {
      const g = factory.getGraph();
      if (!g) {
        throw new Error("Workspace services not ready");
      }
      const settingsFile =
        params.scope === "user"
          ? globalSettingsPath(factory.deps.agentDir)
          : projectSettingsPath(g.canonicalCwd);
      const current = readSkillEntries(settingsFile);
      const next =
        action === "add"
          ? current.includes(params.path)
            ? current
            : [...current, params.path]
          : current.filter((entry) => entry !== params.path);
      if (next.length !== current.length || action === "add") {
        writeSkillEntries(settingsFile, next);
      }
      // Pick up the settings change in the live graph so the returned snapshot
      // reflects reality. Existing sessions keep their system prompt; the new
      // skill set applies to reloaded/new sessions.
      try {
        await g.settingsManager?.reload();
        await factory.invalidateRetainedRuntimeCaches?.();
        if (g.resourceLoader) {
          await g.resourceLoader.reload();
          g.resourceReloadRequired = false;
        }
      } catch (error) {
        g.resourceReloadRequired = true;
        logger.warn("Skill resource reload failed after settings mutation", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // The canonical resource ID map that `resource.setPreference` (skill
      // toggles in the Skills settings) resolves against is only rebuilt during
      // graph publication or package mutations. Rebuild it here too: resources
      // discovered by the just-reloaded loader (e.g. a newly added skill
      // directory) would otherwise fail the toggle lookup with
      // RESOURCE_NOT_FOUND ("Resource not found: res_...").
      if (g.packageManager && g.settingsManager) {
        try {
          const { buildPackageSnapshot } = await import("./package-snapshot.js");
          g.packageSnapshot = await buildPackageSnapshot({
            revision: server.identity.packageRevision,
            workspaceId: g.workspaceId,
            scope: "all",
            packageManager: g.packageManager,
            settingsManager: g.settingsManager,
            resourceLoader: g.resourceLoader,
            cwd: g.canonicalCwd,
            agentDir: factory.deps.agentDir,
            packageUpdateCheck: factory.deps.packageUpdateCheck,
            resourceIdMap: g.resourceIdMap,
            resourceReloadRequired: g.resourceReloadRequired,
          });
        } catch (error) {
          g.resourceReloadRequired = true;
          logger.warn("Package snapshot rebuild failed after skill path mutation", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return buildSkillSnapshot(factory, g, server.identity.workspaceRevision, g.workspaceId);
    },
  });
  if (!out.ok) return { error: out.error, identity: out.identity };
  return { result: out.result, identity: out.identity };
}

export function createSkillHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "skill.list": async (ctx) => {
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
          return buildSkillSnapshot(factory, g, server.identity.workspaceRevision, g.workspaceId);
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },
    "skill.addPath": async (ctx) => mutateSkillPaths(factory, ctx, "add"),
    "skill.removePath": async (ctx) => mutateSkillPaths(factory, ctx, "remove"),
  };
}
