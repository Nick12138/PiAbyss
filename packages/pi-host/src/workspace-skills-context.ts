/**
 * Transient per-workspace service contexts for cross-workspace skill
 * management.
 *
 * The Settings → Skills page can target any workspace, not only the active
 * one. Instead of routing requests into parked (retained) graphs — which the
 * STALE_REVISION identity model and serviceGraphLock deliberately forbid — a
 * lightweight standalone context (SettingsManager + DefaultPackageManager +
 * DefaultResourceLoader) is built for the target workspace's cwd. This mirrors
 * the service subset a workspace graph builds in workspace-lifecycle.ts, but
 * never touches the active graph, host identity, or global revisions.
 *
 * Contexts are cached briefly (TTL) and serialized through one mutex so two
 * target-workspace requests never interleave SDK loads. Any mutation via this
 * module invalidates the cache; bound-workspace changes (park / reactivate /
 * switch) invalidate it too so a reactivated graph's reload is observed.
 */
import { createHash } from "node:crypto";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type WorkspaceTargetRef,
} from "@piabyss/protocol";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { buildPackageSnapshot, type ResourceIdMap } from "./package-snapshot.js";
import { withoutImplicitPackageInstall } from "./offline-package-resolution.js";
import { logger } from "./logger.js";

/** Standalone service subset for one workspace cwd (never the active graph). */
export type TransientWorkspaceView = {
  /** Bound workspace id when the workspace is bound; deterministic otherwise. */
  workspaceId: string;
  canonicalCwd: string;
  settingsManager: SettingsManager;
  packageManager: DefaultPackageManager;
  resourceLoader: DefaultResourceLoader;
  /** Filled by buildPackageSnapshot during view construction. */
  resourceIdMap: ResourceIdMap;
  projectTrusted: boolean;
  /** Transient views are always freshly loaded; no pending reload flag. */
  resourceReloadRequired: false;
};

export type ResolvedWorkspaceTarget =
  | { isActive: true }
  | { isActive: false; canonicalCwd: string; workspaceId: string | null };

const VIEW_CACHE_TTL_MS = 15_000;
const viewCache = new Map<string, { expiresAt: number; promise: Promise<TransientWorkspaceView> }>();

/** Single-flight: transient builds/mutations must not interleave. */
let transientMutex: Promise<unknown> = Promise.resolve();
export async function withTransientWorkspaceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = transientMutex.then(fn, fn);
  transientMutex = run.catch(() => undefined);
  return run;
}

/**
 * Resolve a request's optional WorkspaceTargetRef. No target fields — or a
 * target that resolves to the active workspace's canonical cwd — yields
 * "active", which callers must serve from the live graph under the existing
 * identity/lock machinery.
 */
export function resolveWorkspaceTarget(
  factory: WorkspaceGraphFactory,
  target: WorkspaceTargetRef | null | undefined,
): ResolvedWorkspaceTarget | HostError {
  if (
    !target ||
    (target.targetWorkspaceId === undefined && target.targetWorkspaceCwd === undefined)
  ) {
    return { isActive: true };
  }
  const active = factory.getGraph();
  if (target.targetWorkspaceId !== undefined) {
    const bound = factory
      .buildBoundWorkspaces()
      .find((ref) => ref.workspaceId === target.targetWorkspaceId);
    if (!bound) {
      return createHostError(
        "INVALID_REQUEST",
        `Workspace is not bound to this Host: ${target.targetWorkspaceId}`,
      );
    }
    if (active && bound.cwd === active.canonicalCwd) return { isActive: true };
    return { isActive: false, canonicalCwd: bound.cwd, workspaceId: bound.workspaceId };
  }
  let canonical: string;
  try {
    canonical = factory.canonicalizeCwd(target.targetWorkspaceCwd!);
  } catch (error) {
    // canonicalizeCwd throws a ready-made HostError for missing directories.
    return error as HostError;
  }
  if (active && canonical === active.canonicalCwd) return { isActive: true };
  const bound = factory.buildBoundWorkspaces().find((ref) => ref.cwd === canonical);
  return { isActive: false, canonicalCwd: canonical, workspaceId: bound?.workspaceId ?? null };
}

/** isUuid-compatible deterministic id for workspaces never bound this session. */
function deterministicWorkspaceId(canonicalCwd: string): string {
  const namespace = Buffer.from(
    "5f2a1c9e8b1d4c3a9e2f1a2b3c4d5e6f".replace(/-/g, ""),
    "hex",
  );
  const bytes = createHash("sha1").update(namespace).update(canonicalCwd, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function buildTransientWorkspaceView(
  factory: WorkspaceGraphFactory,
  canonicalCwd: string,
): Promise<TransientWorkspaceView> {
  const agentDir = factory.deps.agentDir;
  // Mirror workspace-lifecycle.ts: project trust defaults on unless the user
  // set project trust to "never".
  const probe = SettingsManager.create(canonicalCwd, agentDir, { projectTrusted: false });
  const projectTrusted = probe.getDefaultProjectTrust() !== "never";
  const settingsManager = SettingsManager.create(canonicalCwd, agentDir, { projectTrusted });
  const packageManager = new DefaultPackageManager({
    cwd: canonicalCwd,
    agentDir,
    settingsManager,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: canonicalCwd,
    agentDir,
    settingsManager,
  });
  // Discovery must never npm-install or git-clone missing packages — same
  // rule as workspace selection and session creation.
  await withoutImplicitPackageInstall(() => resourceLoader.reload());
  const bound = factory.buildBoundWorkspaces().find((ref) => ref.cwd === canonicalCwd);
  const workspaceId = bound?.workspaceId ?? deterministicWorkspaceId(canonicalCwd);
  const resourceIdMap: ResourceIdMap = new Map();
  await buildPackageSnapshot({
    revision: 0,
    workspaceId,
    scope: "all",
    packageManager,
    settingsManager,
    resourceLoader,
    cwd: canonicalCwd,
    agentDir,
    packageUpdateCheck: false,
    resourceIdMap,
    resourceReloadRequired: false,
  });
  return {
    workspaceId,
    canonicalCwd,
    settingsManager,
    packageManager,
    resourceLoader,
    resourceIdMap,
    projectTrusted,
    resourceReloadRequired: false,
  };
}

/**
 * Cached transient view for read paths. Returns a cached build when fresh;
 * callers that mutate settings must build fresh (see
 * buildFreshTransientWorkspaceView) and invalidate afterwards.
 */
export async function getTransientWorkspaceView(
  factory: WorkspaceGraphFactory,
  canonicalCwd: string,
): Promise<TransientWorkspaceView> {
  const cached = viewCache.get(canonicalCwd);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = buildTransientWorkspaceView(factory, canonicalCwd);
  viewCache.set(canonicalCwd, { expiresAt: Date.now() + VIEW_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    viewCache.delete(canonicalCwd);
    throw error;
  }
}

/** Fresh (cache-bypassing) view for mutation paths; also invalidates the cache. */
export async function buildFreshTransientWorkspaceView(
  factory: WorkspaceGraphFactory,
  canonicalCwd: string,
): Promise<TransientWorkspaceView> {
  viewCache.delete(canonicalCwd);
  return withTransientWorkspaceLock(() => buildTransientWorkspaceView(factory, canonicalCwd));
}

/** Drop every cached transient view (disk-side settings changed). */
export function invalidateTransientWorkspaceViews(): void {
  viewCache.clear();
}

/** Mutations are refused while any bound workspace has a busy session. */
export function workspaceMutationBusyError(factory: WorkspaceGraphFactory): HostError | null {
  if (factory.hasAnyBusySessions()) {
    return createHostError(
      "AGENT_BUSY",
      "Stop the agent before modifying workspace skills",
      { retryable: true },
    );
  }
  return null;
}

/**
 * Keep a parked graph's in-memory settings consistent after this module wrote
 * settings files behind its back. The active graph is excluded — active-graph
 * mutations reload through their own path. Disk drift is additionally covered
 * by the lifecycle's fingerprint verification; this reload just makes the
 * parked graph observably consistent immediately.
 */
export async function refreshBoundGraphSettings(
  factory: WorkspaceGraphFactory,
  canonicalCwd: string,
): Promise<void> {
  const active = factory.getGraph();
  if (active && active.canonicalCwd === canonicalCwd) return;
  const bound = factory.findBoundGraph(canonicalCwd);
  if (!bound?.settingsManager) return;
  try {
    await bound.settingsManager.reload();
  } catch (error) {
    logger.warn("Retained graph settings reload after cross-workspace mutation failed", {
      canonicalCwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
