import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Eye,
  FolderOpen,
  Folder,
  HelpCircle,
  Plus,
  RefreshCw,
  Trash2,
  User,
} from "lucide-react";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import type {
  HostRequestParams,
  PackageMutationResult,
  PromptInfo,
  PromptSnapshot,
  ResourcePreferenceUpdate,
  ResourceRecord,
  SkillInfo,
  SkillSettingsScope,
  SkillSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import {
  mergeHostIdentity,
  sessionPackageContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { SkillPreviewModal } from "./SkillPreviewModal";

type LoadState = "idle" | "loading" | "ready" | "error";

type SkillGroupId = "user" | "project" | "bundle";

type SkillRow = {
  key: string;
  name: string;
  description?: string;
  filePath: string;
  groupId: SkillGroupId;
  /** Loaded (active in the current resource loader) skill metadata. */
  skill?: SkillInfo;
  /** Preference-bearing inventory entry; present even for disabled skills. */
  resource?: ResourceRecord;
};

/** Normalize Windows/POSIX spelling so loader paths and resolved paths join. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLocaleLowerCase();
}

/** Parent directory of a file path, keeping Windows drive letters intact. */
function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : path;
}

function groupIdOf(skill?: SkillInfo, resource?: ResourceRecord): SkillGroupId {
  const origin = skill?.origin ?? resource?.origin;
  const scope = skill?.scope ?? resource?.scope;
  // Package-shipped and extension/runtime-registered skills share one bucket.
  if (origin === "package" || origin === "extension" || scope === "temporary") return "bundle";
  return scope === "project" ? "project" : "user";
}

function buildRows(skills: SkillInfo[], resources: ResourceRecord[]): SkillRow[] {
  const rows = new Map<string, SkillRow>();
  for (const skill of skills) {
    const key = normalizePath(skill.filePath);
    rows.set(key, {
      key,
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      groupId: groupIdOf(skill, undefined),
      skill,
    });
  }
  for (const resource of resources) {
    const key = normalizePath(resource.path);
    const existing = rows.get(key);
    if (existing) {
      existing.resource = resource;
      // The projection applies preferences; a disabled skill stays in the list.
      existing.groupId = groupIdOf(existing.skill, resource);
      continue;
    }
    rows.set(key, {
      key,
      name: resource.name,
      description: resource.description,
      filePath: resource.path,
      groupId: groupIdOf(undefined, resource),
      resource,
    });
  }
  return [...rows.values()];
}

/** Toggle write scope by group: user skills → user, project skills → project, packages & extensions → view-only. */
function toggleScopeForGroup(groupId: SkillGroupId): "user" | "project" | null {
  return groupId === "user" ? "user" : groupId === "project" ? "project" : null;
}

/** Effective state after user and project preferences are layered. */
function effectiveEnabled(resource: ResourceRecord): boolean {
  const project = resource.preferences.project;
  if (project === "enabled") return true;
  if (project === "disabled") return false;
  const user = resource.preferences.user;
  if (user === "enabled") return true;
  if (user === "disabled") return false;
  return resource.enabled;
}

function groupIcon(id: SkillGroupId) {
  return id === "user" ? User : id === "project" ? Folder : Boxes;
}

/**
 * Prompts are shown alongside skills inside the user/project group cards
 * (never in the bundle group). Non-existent files are already filtered by the
 * host, so every returned entry is rendered.
 */
function promptsForGroup(
  promptSnapshot: PromptSnapshot | null,
  groupId: SkillGroupId,
): PromptInfo[] {
  if (!promptSnapshot) return [];
  if (groupId === "user") return promptSnapshot.prompts.filter((prompt) => prompt.scope === "user");
  if (groupId === "project") {
    return promptSnapshot.prompts.filter((prompt) => prompt.scope === "project");
  }
  return [];
}

/** Human-readable label for a prompt kind (override/append/merge groups). */
function promptKindLabel(kind: PromptInfo["kind"], t: Translate): string {
  if (kind === "system") return t("promptKindSystem");
  if (kind === "append") return t("promptKindAppend");
  return t("promptKindContext");
}

export function SkillsSettings() {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const pushNotification = useAppStore((state) => state.pushNotification);

  const [snapshot, setSnapshot] = useState<SkillSnapshot | null>(null);
  const [promptSnapshot, setPromptSnapshot] = useState<PromptSnapshot | null>(null);
  const [resources, setResources] = useState<ResourceRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newScope, setNewScope] = useState<SkillSettingsScope>("project");
  const [previewSkill, setPreviewSkill] = useState<{ name: string; filePath: string } | null>(
    null,
  );
  const [showPromptHelp, setShowPromptHelp] = useState(false);
  // 全局/项目 default expanded; bundle (packages & extensions) default collapsed.
  const [collapsed, setCollapsed] = useState<Record<SkillGroupId, boolean>>({
    user: false,
    project: false,
    bundle: true,
  });
  const refreshRequest = useRef(0);

  async function applyResponse<T extends { hostInstanceId?: string }>(response: T) {
    const current = useAppStore.getState();
    const nextHost = current.host && mergeHostIdentity(current.host, response as never);
    if (nextHost) current.setHost(nextHost);
  }

  async function refresh() {
    if (!host || !workspace?.servicesReady) {
      setSnapshot(null);
      setPromptSnapshot(null);
      setResources([]);
      setLoadState("idle");
      return;
    }
    const request = ++refreshRequest.current;
    setLoadState("loading");
    setLoadError("");
    // Workspace switched: drop the previous workspace's snapshot so stale
    // project skills do not linger while the new workspace loads.
    if (snapshot && workspace && snapshot.workspaceId !== workspace.id) {
      setSnapshot(null);
      setPromptSnapshot(null);
      setResources([]);
    }
    try {
      const [skillResponse, packageResponse, promptResponse] = await Promise.all([
        hostClient.request("skill.list", workspaceContext(host, workspace), null, 30_000),
        hostClient.request(
          "package.list",
          workspaceContext(host, workspace),
          { scope: "all", includeResources: true } satisfies HostRequestParams["package.list"],
          60_000,
        ),
        hostClient.request("prompt.list", workspaceContext(host, workspace), null, 30_000),
      ]);
      if (refreshRequest.current !== request) return;
      if (!skillResponse.ok) {
        throw new Error(skillResponse.error?.message ?? t("notifSkillsLoadFailed"));
      }
      setSnapshot(skillResponse.result);
      // prompt.list is best-effort: a failure must not block the skills view.
      if (promptResponse.ok) {
        setPromptSnapshot(promptResponse.result);
      } else {
        setPromptSnapshot(null);
      }
      if (packageResponse.ok) {
        setResources(
          packageResponse.result.resources.filter((resource) => resource.type === "skill"),
        );
      }
      await applyResponse(skillResponse);
      setLoadState("ready");
    } catch (error) {
      if (refreshRequest.current !== request) return;
      setLoadError(error instanceof Error ? error.message : t("notifSkillsLoadFailed"));
      setLoadState("error");
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      refreshRequest.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId, workspace?.id, workspace?.revision]);

  async function mutatePath(
    method: "skill.addPath" | "skill.removePath",
    path: string,
    scope: SkillSettingsScope,
  ) {
    if (!host || !workspace || busy) return;
    setBusy(true);
    try {
      const response = await hostClient.request(
        method,
        workspaceContext(host, workspace),
        { path, scope },
        30_000,
      );
      if (!response.ok) {
        throw new Error(
          response.error?.message ??
            t(
              method === "skill.addPath" ? "notifSkillPathAddFailed" : "notifSkillPathRemoveFailed",
            ),
        );
      }
      setSnapshot(response.result);
      await applyResponse(response);
      if (method === "skill.addPath") setNewPath("");
      // The path change reloads resources; resync the toggle inventory.
      void refresh();
    } catch (error) {
      pushNotification(
        error instanceof Error
          ? error.message
          : t(
              method === "skill.addPath" ? "notifSkillPathAddFailed" : "notifSkillPathRemoveFailed",
            ),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleResource(resource: ResourceRecord, groupId: SkillGroupId) {
    if (!host || !workspace || busy) return;
    const targetScope = toggleScopeForGroup(groupId);
    if (!targetScope) return; // Packages & extensions are view-only in this page.
    const params: ResourcePreferenceUpdate = {
      resourceId: resource.id,
      targetScope,
      preference: effectiveEnabled(resource) ? "disabled" : "enabled",
    };
    setBusy(true);
    try {
      const response = await hostClient.request(
        "resource.setPreference",
        sessionPackageContext(host, workspace),
        params,
        null,
      );
      if (!response.ok) {
        throw new Error(response.error?.message ?? t("notifSkillToggleFailed"));
      }
      const result = response.result as PackageMutationResult;
      setResources(
        result.packageSnapshot.resources.filter((resource) => resource.type === "skill"),
      );
      useAppStore.getState().applyPackageMutationResult(result);
      await applyResponse(response);
      // Reload flips which skills the loader reports as loaded; resync.
      void refresh();
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSkillToggleFailed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function pickSkillDirectory() {
    if (!host || busy) return;
    let picked: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") picked = selected;
    } catch {
      // Non-desktop / test environment: fall back to a textual prompt.
      picked = window.prompt(t("skillsEnterPath")) || null;
    }
    if (picked) setNewPath(picked);
  }

  async function openPath(path: string) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path });
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSkillFileOpenFailed"),
        "error",
      );
    }
  }

  /** Open the skill's own directory (not its SKILL.md document) in the file manager. */
  async function openSkillFolder(row: SkillRow) {
    await openPath(row.skill?.baseDir ?? parentDir(row.filePath));
  }

  const rows = snapshot ? buildRows(snapshot.skills, resources) : [];
  // Every group stays visible so empty scopes are discoverable.
  const groups: Array<{ id: SkillGroupId; rows: SkillRow[]; prompts: PromptInfo[] }> = (
    ["user", "project", "bundle"] as const
  ).map((id) => ({
    id,
    rows: rows.filter((row) => row.groupId === id),
    prompts: promptsForGroup(promptSnapshot, id),
  }));
  const groupLabel = (id: SkillGroupId) =>
    id === "user"
      ? t("skillsGroupUser")
      : id === "project"
        ? t("skillsGroupProject")
        : t("skillsGroupBundle");

  if (!host || !workspace?.servicesReady) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
          <p className="mx-auto max-w-3xl rounded-lg border border-border p-4 text-sm text-muted">
            {t("skillsNoWorkspace")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-skills-settings>
      <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted">
              {snapshot
                ? t("skillsSummary", {
                    loaded: String(rows.length),
                    configured: String(snapshot.configuredPaths.length),
                  })
                : " "}
            </p>
            <button
              type="button"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
              title={t("skillsRefresh")}
              aria-label={t("skillsRefresh")}
              disabled={loadState === "loading" || busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} className={loadState === "loading" ? "animate-spin" : ""} />
            </button>
          </div>

          {snapshot?.resourceReloadRequired && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t("skillsReloadRequired")}</span>
            </p>
          )}

          {loadState === "error" && (
            <p role="alert" className="rounded-lg border border-danger/40 p-3 text-xs text-danger">
              {loadError}
            </p>
          )}

          {snapshot && snapshot.diagnostics.length > 0 && (
            <section>
              <h2 className="mb-2 text-[13px] font-medium text-muted">
                {t("skillsDiagnosticsTitle")}
              </h2>
              <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
                {snapshot.diagnostics.map((diagnostic, index) => (
                  <p key={index} className="flex items-start gap-2 text-xs text-muted">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" />
                    <span className="min-w-0">
                      <span className="break-words">{diagnostic.message}</span>
                      {diagnostic.path && (
                        <span className="block truncate font-mono text-[11px]">
                          {diagnostic.path}
                        </span>
                      )}
                    </span>
                  </p>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-medium text-muted">{t("skillsLoadedTitle")}</h2>
                {(snapshot || promptSnapshot) && (
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
                    title={t("promptsHelpTitle")}
                    aria-label={t("promptsHelpTitle")}
                    onClick={() => setShowPromptHelp(true)}
                  >
                    <HelpCircle size={14} />
                  </button>
                )}
              </div>
              {snapshot && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    snapshot.projectTrusted
                      ? "bg-success/15 text-success"
                      : "bg-warning/15 text-warning"
                  }`}
                >
                  {snapshot.projectTrusted ? t("skillsTrusted") : t("skillsUntrusted")}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-4">
              {groups.map((group) => {
                const Icon = groupIcon(group.id);
                const isCollapsed = collapsed[group.id];
                const listId = `skills-group-${group.id}`;
                return (
                  <div key={group.id} className="rounded-lg border border-border">
                    <button
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-lg px-4 py-2 text-left transition-colors hover:bg-surface-overlay/60 ${isCollapsed ? "" : "rounded-b-none"}`}
                      aria-expanded={!isCollapsed}
                      aria-controls={listId}
                      onClick={() =>
                        setCollapsed((previous) => ({
                          ...previous,
                          [group.id]: !previous[group.id],
                        }))
                      }
                    >
                      {isCollapsed ? (
                        <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />
                      ) : (
                        <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden />
                      )}
                      <Icon size={14} className="shrink-0 text-muted" aria-hidden />
                      <span className="text-[13px] font-medium">{groupLabel(group.id)}</span>
                      <span className="text-[11px] text-muted">
                        {group.rows.length + group.prompts.length}
                      </span>
                    </button>
                    <CollapsibleRegion open={!isCollapsed} id={listId}>
                      {group.id === "bundle" && (
                        <p className="border-b border-border px-4 py-2 text-[11px] text-muted">
                          {t("skillsBundleReadonly")}
                        </p>
                      )}
                      {group.rows.length === 0 && group.prompts.length === 0 ? (
                        <p className="border-t border-border px-4 py-3 text-xs text-muted">
                          {t("skillsGroupEmpty")}
                        </p>
                      ) : (
                        <ul className="grid gap-3 border-t border-border p-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                          {group.rows.map((row) => {
                            const toggleable = group.id !== "bundle" && Boolean(row.resource);
                            const enabled = row.resource ? effectiveEnabled(row.resource) : true;
                            return (
                              <li
                                key={row.key}
                                className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
                              >
                                <div
                                  className={`flex min-w-0 flex-col gap-2 ${enabled ? "" : "opacity-60"}`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                      <button
                                        type="button"
                                        className="min-w-0 cursor-pointer break-all text-left text-sm font-medium"
                                        title={t("skillsPreviewToggle", { name: row.name })}
                                        aria-label={t("skillsPreviewToggle", { name: row.name })}
                                        onClick={() =>
                                          setPreviewSkill({
                                            name: row.name,
                                            filePath: row.filePath,
                                          })
                                        }
                                      >
                                        {row.name}
                                      </button>
                                      {row.skill?.disableModelInvocation && (
                                        <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] text-muted">
                                          {t("skillsBadgeCommandOnly")}
                                        </span>
                                      )}
                                      {row.skill?.origin === "package" && (
                                        <span className="max-w-40 truncate rounded-full bg-selection/40 px-2 py-0.5 text-[11px] text-muted">
                                          {row.skill.source}
                                        </span>
                                      )}
                                      {row.resource && !enabled && (
                                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">
                                          {t("skillsBadgeDisabled")}
                                        </span>
                                      )}
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1">
                                      <button
                                        type="button"
                                        className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
                                        title={t("skillsOpen")}
                                        aria-label={`${t("skillsOpen")} ${row.name}`}
                                        onClick={() => void openSkillFolder(row)}
                                      >
                                        <FolderOpen size={14} />
                                      </button>
                                      {toggleable ? (
                                        <span
                                          title={t(enabled ? "skillsDisable" : "skillsEnable")}
                                          className="flex shrink-0 items-center"
                                        >
                                          <Switch
                                            checked={enabled}
                                            disabled={busy}
                                            label={t("skillsToggleAria", { name: row.name })}
                                            onChange={() =>
                                              row.resource &&
                                              void toggleResource(row.resource, group.id)
                                            }
                                          />
                                        </span>
                                      ) : null}
                                    </span>
                                  </div>
                                  {row.description && (
                                    <span className="line-clamp-2 break-words text-xs text-muted">
                                      {row.description}
                                    </span>
                                  )}
                                  <span
                                    className="truncate font-mono text-[11px] text-muted"
                                    title={row.filePath}
                                  >
                                    {row.filePath}
                                  </span>
                                </div>
                              </li>
                            );
                          })}
                          {group.prompts.map((prompt) => (
                            <li
                              key={`prompt:${prompt.scope}:${prompt.name}`}
                              className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
                            >
                              <div className="flex min-w-0 flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      className="min-w-0 cursor-pointer break-all text-left text-sm font-medium"
                                      title={t("promptsPreviewToggle", { name: prompt.name })}
                                      aria-label={t("promptsPreviewToggle", { name: prompt.name })}
                                      onClick={() =>
                                        setPreviewSkill({ name: prompt.name, filePath: prompt.filePath })
                                      }
                                    >
                                      {prompt.name}
                                    </button>
                                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent">
                                      {t("promptBadge")}
                                    </span>
                                    <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] text-muted">
                                      {promptKindLabel(prompt.kind, t)}
                                    </span>
                                    {prompt.loaded ? (
                                      <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">
                                        {t("promptLoaded")}
                                      </span>
                                    ) : (
                                      <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">
                                        {t("promptNotLoaded")}
                                      </span>
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
                                    title={t("promptsPreviewToggle", { name: prompt.name })}
                                    aria-label={t("promptsPreviewToggle", { name: prompt.name })}
                                    onClick={() =>
                                      setPreviewSkill({ name: prompt.name, filePath: prompt.filePath })
                                    }
                                  >
                                    <Eye size={14} />
                                  </button>
                                </div>
                                <span
                                  className="truncate font-mono text-[11px] text-muted"
                                  title={prompt.filePath}
                                >
                                  {prompt.filePath}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CollapsibleRegion>
                  </div>
                );
              })}
              <p className="text-xs text-muted">{t("skillsLoadedHint")}</p>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-[13px] font-medium text-muted">{t("skillsPathsTitle")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <p className="text-xs text-muted">{t("skillsPathsDesc")}</p>
              <ul className="flex flex-col gap-2">
                {(snapshot?.configuredPaths ?? []).length === 0 && (
                  <li className="text-xs text-muted">{t("skillsPathsEmpty")}</li>
                )}
                {(snapshot?.configuredPaths ?? []).map((entry) => (
                  <li
                    key={`${entry.scope}:${entry.path}`}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                        entry.scope === "user"
                          ? "bg-surface-overlay text-muted"
                          : "bg-selection/40 text-muted"
                      }`}
                    >
                      {entry.scope === "user" ? t("skillsScopeUser") : t("skillsScopeProject")}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
                    {!entry.exists && (
                      <span className="shrink-0 text-[11px] text-warning">
                        {t("skillsPathMissing")}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-danger disabled:opacity-50"
                      title={t("skillsRemovePath")}
                      aria-label={`${t("skillsRemovePath")} ${entry.path}`}
                      onClick={() => void mutatePath("skill.removePath", entry.path, entry.scope)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pickSkillDirectory()}
                  title={newPath || t("skillsBrowseDirectory")}
                  aria-label={t("skillsBrowseDirectory")}
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-xs transition-colors hover:bg-surface-overlay/60 focus:border-focus focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <FolderOpen size={14} className="shrink-0 text-muted" />
                  <span
                    className={`min-w-0 flex-1 truncate text-left ${newPath ? "text-foreground" : "text-muted"}`}
                  >
                    {newPath || t("skillsPickDirectoryPlaceholder")}
                  </span>
                </button>
                <Select
                  className="min-w-32"
                  ariaLabel={t("skillsPathsTitle")}
                  value={newScope}
                  onChange={(value) => setNewScope(value as SkillSettingsScope)}
                  options={[
                    { value: "project", label: t("skillsScopeProject") },
                    { value: "user", label: t("skillsScopeUser") },
                  ]}
                />
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy || newPath.trim().length === 0}
                  onClick={() => void mutatePath("skill.addPath", newPath.trim(), newScope)}
                >
                  <Plus size={14} />
                  {t("skillsAddPath")}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
      {previewSkill && (
        <SkillPreviewModal
          name={previewSkill.name}
          filePath={previewSkill.filePath}
          onClose={() => setPreviewSkill(null)}
        />
      )}
      {showPromptHelp && (
        <Dialog
          title={t("promptsHelpTitle")}
          confirmLabel={t("commonClose")}
          showCloseIcon
          hideActions
          maxWidthClass="max-w-[532px]"
          onCancel={() => setShowPromptHelp(false)}
          onConfirm={() => setShowPromptHelp(false)}
        >
          <div className="flex flex-col gap-3 text-xs text-muted">
            <p>{t("promptsHelpIntro")}</p>
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
              <p className="font-medium text-foreground">{t("promptsHelpGlobalDir")}</p>
              <p className="font-mono text-[11px]">~/.pi/agent/</p>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
              <p className="font-medium text-foreground">{t("promptsHelpProjectDir")}</p>
              <p className="font-mono text-[11px]">.pi/</p>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
              <p className="font-medium text-foreground">{t("promptsHelpOverrideTitle")}</p>
              <p>{t("promptsHelpOverride")}</p>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
              <p className="font-medium text-foreground">{t("promptsHelpMergeTitle")}</p>
              <p>{t("promptsHelpMerge")}</p>
            </div>
            <p className="flex items-start gap-2 text-[11px] text-warning">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{t("promptsHelpTrust")}</span>
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
