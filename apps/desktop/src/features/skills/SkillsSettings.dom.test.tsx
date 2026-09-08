/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageSnapshot,
  PromptSnapshot,
  ResourceRecord,
  SkillInfo,
  SkillSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { SkillsSettings } from "./SkillsSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const dialogMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);

function host(overrides: Partial<HostStatusSnapshot> = {}): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "C:/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    ...overrides,
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:\\workspace",
    servicesReady: true,
  };
}

function loadedSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "review",
    description: "Review changes",
    filePath: "C:/agent/skills/review/SKILL.md",
    baseDir: "C:/agent/skills/review",
    source: "user",
    scope: "user",
    origin: "top-level",
    disableModelInvocation: false,
    ...overrides,
  };
}

function skillResource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "resource:skill:review",
    type: "skill",
    name: "review",
    description: "Review changes",
    path: "C:/agent/skills/review/SKILL.md",
    relativePath: "review",
    scope: "user",
    origin: "top-level",
    source: "user",
    enabled: true,
    preferences: { user: "enabled" },
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
    ...overrides,
  };
}

function skillSnapshot(overrides: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    cwd: "C:\\workspace",
    projectTrusted: true,
    skills: [loadedSkill()],
    diagnostics: [],
    configuredPaths: [{ path: "../.claude/skills", scope: "project", exists: true }],
    resourceReloadRequired: false,
    ...overrides,
  };
}

function promptSnapshot(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    cwd: "C:\\workspace",
    agentDir: "C:/agent",
    projectTrusted: true,
    prompts: [
      {
        name: "SYSTEM.md",
        kind: "system",
        scope: "project",
        filePath: "C:/workspace/.pi/SYSTEM.md",
        loaded: true,
      },
      {
        name: "AGENTS.md",
        kind: "context",
        scope: "user",
        filePath: "C:/agent/AGENTS.md",
        loaded: true,
      },
    ],
    ...overrides,
  };
}

function packageSnapshot(resources: ResourceRecord[]): PackageSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "all",
    configured: [],
    resources,
    updateCheck: { supported: true },
    diagnostics: [],
    resourceReloadRequired: false,
  };
}

function mutationResult(resources: ResourceRecord[]): PackageMutationResult {
  return {
    operationId: "00000000-0000-4000-8000-000000000501",
    status: "committed",
    packageSnapshot: packageSnapshot(resources),
    warnings: [],
    reconcileRequired: false,
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: `${method}-test`,
    method,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

describe("SkillsSettings", () => {
  let currentSkills: SkillSnapshot;
  let currentPrompts: PromptSnapshot;
  let currentResources: ResourceRecord[];
  let request: MockInstance<typeof hostClient.request>;

  beforeEach(() => {
    dialogMock.open.mockReset();
    dialogMock.open.mockResolvedValue(null);
    currentSkills = skillSnapshot();
    currentPrompts = promptSnapshot();
    currentResources = [skillResource()];
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "skill.list") return envelope(method, currentSkills);
      if (method === "prompt.list") return envelope(method, currentPrompts);
      if (method === "package.list") return envelope(method, packageSnapshot(currentResources));
      if (method === "resource.setPreference") {
        return envelope(method, mutationResult(currentResources));
      }
      if (method === "skill.addPath" || method === "skill.removePath") {
        return envelope(method, currentSkills);
      }
      throw new Error(`unexpected method ${method}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockRestore();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
  });

  it("renders loaded skills grouped by source with configured paths", async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    expect(screen.getByText("../.claude/skills")).toBeInTheDocument();
    expect(screen.getByText("Project trusted")).toBeInTheDocument();
    expect(request.mock.calls.some(([method]) => method === "skill.list")).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "package.list")).toBe(true);
  });

  it("disables an enabled skill via resource.setPreference at user scope", async () => {
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const toggle = await screen.findByRole("switch", { name: "Toggle skill review" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "resource.setPreference");
      expect(call?.[2]).toEqual({
        resourceId: "resource:skill:review",
        targetScope: "user",
        preference: "disabled",
      });
    });
    await waitFor(() => expect(useAppStore.getState().packages).not.toBeNull());
  });

  it("keeps disabled skills listed with a re-enable switch", async () => {
    currentSkills = skillSnapshot({ skills: [] });
    currentResources = [
      skillResource({
        preferences: { user: "disabled" },
        enabled: false,
      }),
    ];
    render(<SkillsSettings />);
    const toggle = await screen.findByRole("switch", { name: "Toggle skill review" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(toggle);
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "resource.setPreference");
      expect(call?.[2]).toMatchObject({ targetScope: "user", preference: "enabled" });
    });
  });

  it("keeps packages & extensions view-only without toggle switches", async () => {
    currentSkills = skillSnapshot({
      skills: [
        loadedSkill({
          name: "runtime",
          description: "Runtime skill",
          filePath: "runtime://review/SKILL.md",
          baseDir: "runtime://review",
          source: "pi-telegram",
          scope: "temporary",
          origin: "package",
        }),
      ],
    });
    currentResources = [
      skillResource({
        id: "resource:skill:runtime",
        name: "runtime",
        path: "runtime://review/SKILL.md",
        scope: "temporary",
        origin: "extension",
        control: { kind: "read-only", reason: "Temporary resource" },
      }),
    ];
    render(<SkillsSettings />);
    // The bundle group starts collapsed; expand it to reveal the view-only rows.
    const bundleHeader = await screen.findByRole("button", { name: /Packages & Extensions/ });
    expect(bundleHeader).toHaveAttribute("aria-expanded", "false");
    const user = userEvent.setup();
    await user.click(bundleHeader);
    expect(bundleHeader).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("runtime")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Toggle skill runtime" })).not.toBeInTheDocument();
    expect(screen.getByText(/view-only/)).toBeInTheDocument();
  });

  it("keeps user-installed package skills view-only in the skills page", async () => {
    currentSkills = skillSnapshot({ skills: [] });
    currentResources = [
      skillResource({
        id: "resource:skill:pkg",
        name: "pkg-skill",
        path: "C:/agent/npm/node_modules/pi-x/skills/pkg-skill/SKILL.md",
        relativePath: "skills/pkg-skill/SKILL.md",
        scope: "user",
        origin: "package",
        source: "npm:pi-x",
        packageId: "package:user:npm:pi-x",
        control: { kind: "preference", scopes: ["user", "project"] },
      }),
    ];
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const bundleHeader = await screen.findByRole("button", { name: /Packages & Extensions/ });
    await user.click(bundleHeader);
    expect(await screen.findByText("pkg-skill")).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Toggle skill pkg-skill" }),
    ).not.toBeInTheDocument();
  });

  it("toggles a project skill at project scope", async () => {
    currentSkills = skillSnapshot({
      skills: [
        loadedSkill({
          name: "project-review",
          filePath: "C:/workspace/.pi/skills/project-review/SKILL.md",
          baseDir: "C:/workspace/.pi/skills/project-review",
          source: "project",
          scope: "project",
        }),
      ],
    });
    currentResources = [
      skillResource({
        id: "resource:skill:project-review",
        name: "project-review",
        path: "C:/workspace/.pi/skills/project-review/SKILL.md",
        relativePath: "project-review",
        scope: "project",
        origin: "top-level",
        source: "project",
        preferences: { project: "inherit" },
        control: { kind: "preference", scopes: ["project"] },
      }),
    ];
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const toggle = await screen.findByRole("switch", { name: "Toggle skill project-review" });
    await user.click(toggle);
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "resource.setPreference");
      expect(call?.[2]).toEqual({
        resourceId: "resource:skill:project-review",
        targetScope: "project",
        preference: "disabled",
      });
    });
  });

  it("refreshes the skill list when the workspace changes", async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    const listCalls = () => request.mock.calls.filter(([method]) => method === "skill.list").length;
    const before = listCalls();
    useAppStore.getState().setWorkspace({
      ...workspace(),
      id: "w2",
      revision: 2,
      cwd: "C:/other",
      canonicalCwd: "C:\\other",
    });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it("keeps global and project groups expanded by default and collapsible", async () => {
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const globalHeader = await screen.findByRole("button", { name: /Global \(user\)/ });
    const projectHeader = screen.getByRole("button", { name: /Project/ });
    expect(globalHeader).toHaveAttribute("aria-expanded", "true");
    expect(projectHeader).toHaveAttribute("aria-expanded", "true");
    await user.click(globalHeader);
    expect(globalHeader).toHaveAttribute("aria-expanded", "false");
    await user.click(globalHeader);
    expect(globalHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the skill's own folder rather than the SKILL.md file", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as MockInstance).mockClear();
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const openButton = await screen.findByRole("button", { name: "Open review" });
    await user.click(openButton);
    // The skill's baseDir is handed to the host, not the SKILL.md document,
    // so the file manager opens the skill folder (a bare directory arg — no
    // `/select,` prefix — which also survives spaces in WPS cloud paths).
    expect(invoke).toHaveBeenCalledWith("desktop_open_path", {
      path: "C:/agent/skills/review",
    });
  });

  it("opens a SKILL.md preview dialog when the skill name is clicked", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeMock = invoke as unknown as MockInstance;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "desktop_read_small_file") {
        return {
          kind: "text",
          name: "SKILL.md",
          sizeBytes: 28,
          text: "# Review\n\nReview the code changes.",
        };
      }
      throw new Error(`unexpected command ${command}`);
    });
    try {
      const user = userEvent.setup();
      render(<SkillsSettings />);
      const nameButton = await screen.findByRole("button", { name: "Preview skill review" });
      await user.click(nameButton);
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(invokeMock).toHaveBeenCalledWith("desktop_read_small_file", {
        path: "C:/agent/skills/review/SKILL.md",
      });
      await waitFor(() => expect(screen.getByText(/Review the code changes/)).toBeInTheDocument());
      // The dialog does not bind Escape (the app-level shortcut owns it);
      // close via the ✕ button instead.
      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } finally {
      invokeMock.mockReset();
    }
  });

  it("shows a localized error when the skill file cannot be read", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeMock = invoke as unknown as MockInstance;
    invokeMock.mockReset();
    invokeMock.mockRejectedValue("file is not valid UTF-8 text");
    try {
      const user = userEvent.setup();
      render(<SkillsSettings />);
      const nameButton = await screen.findByRole("button", { name: "Preview skill review" });
      await user.click(nameButton);
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText(/not valid UTF-8/)).toBeInTheDocument());
    } finally {
      invokeMock.mockReset();
    }
  });

  it("adds a skill directory picked from the folder dialog to project settings", async () => {
    dialogMock.open.mockResolvedValue("C:/team/skills");
    const user = userEvent.setup();
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect(dialogMock.open).toHaveBeenCalledWith({ directory: true, multiple: false });
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "skill.addPath");
      expect(call?.[2]).toEqual({ path: "C:/team/skills", scope: "project" });
    });
  });

  it("renders existing prompt files inside the global and project groups", async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    expect(screen.getByText("SYSTEM.md")).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
    // Prompt badge labels every entry; kind badges distinguish override/merge.
    expect(screen.getAllByText("Prompt").length).toBe(2);
    expect(screen.getByText("Override")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
    expect(screen.getByText("C:/workspace/.pi/SYSTEM.md")).toBeInTheDocument();
    expect(screen.getByText("C:/agent/AGENTS.md")).toBeInTheDocument();
    expect(request.mock.calls.some(([method]) => method === "prompt.list")).toBe(true);
  });

  it("marks a shadowed global prompt as not loaded", async () => {
    currentPrompts = promptSnapshot({
      projectTrusted: true,
      prompts: [
        {
          name: "SYSTEM.md",
          kind: "system",
          scope: "project",
          filePath: "C:/workspace/.pi/SYSTEM.md",
          loaded: true,
        },
        {
          name: "SYSTEM.md",
          kind: "system",
          scope: "user",
          filePath: "C:/agent/SYSTEM.md",
          loaded: false,
        },
      ],
    });
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    expect(screen.getByText("Not loaded")).toBeInTheDocument();
    expect(screen.getAllByText("Loaded").length).toBe(1);
  });

  it("opens a prompt preview dialog reusing the skill preview modal", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeMock = invoke as unknown as MockInstance;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "desktop_read_small_file") {
        return {
          kind: "text",
          name: "SYSTEM.md",
          sizeBytes: 20,
          text: "# System\n\nProject instructions.",
        };
      }
      throw new Error(`unexpected command ${command}`);
    });
    try {
      const user = userEvent.setup();
      render(<SkillsSettings />);
      const previewButton = (
        await screen.findAllByRole("button", {
          name: "Preview prompt SYSTEM.md",
        })
      )[0];
      await user.click(previewButton);
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(invokeMock).toHaveBeenCalledWith("desktop_read_small_file", {
        path: "C:/workspace/.pi/SYSTEM.md",
      });
      await waitFor(() => expect(screen.getByText(/Project instructions/)).toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } finally {
      invokeMock.mockReset();
    }
  });

  it("opens the prompt help dialog and closes it", async () => {
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const helpButton = await screen.findByRole("button", { name: "Prompt files" });
    await user.click(helpButton);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Override \(SYSTEM.md \/ APPEND_SYSTEM.md\)/)).toBeInTheDocument();
    expect(screen.getByText(/Merge \(AGENTS.md \/ CLAUDE.md\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
