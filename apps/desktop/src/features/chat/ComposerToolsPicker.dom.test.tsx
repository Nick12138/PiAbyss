/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  PluginLibraryCatalog,
  SessionSnapshot,
  ToolSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ComposerToolsPicker } from "./ComposerToolsPicker";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/repo",
    canonicalCwd: "/repo",
    revision: 1,
    servicesReady: true,
  };
}

function toolSnapshot(tools: ToolSnapshot["tools"], active: string[]): ToolSnapshot {
  return {
    revision: 1,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    tools,
    active,
  };
}

function session(tools: ToolSnapshot): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/repo",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 7, steering: [], followUp: [] },
    messages: [],
    tools,
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "picker-test",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

const SHELLJOB_SOURCE = "C:/repo/packages/pi-shelljob/extensions/pi-shelljob.ts";
const MEMO_SOURCE = "C:/repo/packages/piabyss-memo/extensions/piabyss-memo.ts";

function catalog(): PluginLibraryCatalog {
  return {
    specVersion: 1,
    registryUrl: "https://example/plugins.json",
    repoSource: "git:github.com/Nick12138/my-pi-plugins",
    fetchedAt: 0,
    warnings: [],
    plugins: [
      {
        id: "pi-shelljob",
        name: "后台 Shell",
        description: "",
        icon: "\u26A1",
        version: "0.1.0",
        install: { type: "repo", path: "packages/pi-shelljob" },
      },
      {
        id: "piabyss-memo",
        name: "PiAbyss 备忘录",
        description: "",
        icon: "\uD83D\uDCCC",
        version: "0.1.0",
        install: { type: "repo", path: "packages/piabyss-memo" },
        toggleScopes: ["user"],
      },
    ],
  };
}

/** Snapshot with the seven built-ins, the attachment tool, a workspace-
 *  toggleable plugin tool and a global-only plugin tool. */
const FULL_TOOLS: ToolSnapshot["tools"] = [
  { name: "read", sourcePath: "<builtin:read>" },
  { name: "bash", sourcePath: "<builtin:bash>" },
  { name: "edit", sourcePath: "<builtin:edit>" },
  { name: "write", sourcePath: "<builtin:write>" },
  { name: "grep", sourcePath: "<builtin:grep>" },
  { name: "find", sourcePath: "<builtin:find>" },
  { name: "ls", sourcePath: "<builtin:ls>" },
  { name: "read_attachment", sourcePath: "<sdk:read_attachment>" },
  {
    name: "shelljob",
    label: "后台 Shell",
    sourcePath: SHELLJOB_SOURCE,
  },
  {
    name: "shell_wait",
    label: "Shell Wait",
    sourcePath: SHELLJOB_SOURCE,
  },
  {
    name: "piabyss_memo",
    label: "备忘录",
    sourcePath: MEMO_SOURCE,
  },
];

function mockCatalogRequests(activeOverrides?: (method: string) => unknown) {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
    if (method === "pluginLibrary.catalog") {
      return envelope(method, catalog()) as never;
    }
    const overridden = activeOverrides?.(method);
    if (overridden !== undefined) {
      return envelope(method, overridden) as never;
    }
    if (method === "package.list") {
      return envelope(method, {
        revision: 1,
        workspaceId: WORKSPACE_ID,
        scope: "all",
        configured: [
          {
            id: "pkg-repo",
            identity: "git:github.com/Nick12138/my-pi-plugins",
            source: "git:github.com/Nick12138/my-pi-plugins",
            kind: "git",
            scope: "user",
            filtered: false,
            installed: true,
            displayName: "my-pi-plugins",
            effective: true,
            resourceCounts: null,
            resourceCountsState: "resolvedEffective",
          },
        ],
        resources: [
          {
            id: "res-shelljob",
            type: "extension",
            name: "pi-shelljob",
            path: SHELLJOB_SOURCE,
            scope: "user",
            origin: "package",
            source: "my-pi-plugins",
            packageId: "pkg-repo",
            enabled: true,
            preferences: {},
            control: { kind: "preference", scopes: ["user", "project"] },
            diagnostics: [],
          },
          {
            id: "res-memo",
            type: "extension",
            name: "piabyss-memo",
            path: MEMO_SOURCE,
            scope: "user",
            origin: "package",
            source: "my-pi-plugins",
            packageId: "pkg-repo",
            enabled: true,
            preferences: {},
            control: { kind: "preference", scopes: ["user", "project"] },
            diagnostics: [],
          },
        ],
        updateCheck: { supported: false },
        diagnostics: [],
        resourceReloadRequired: false,
      }) as never;
    }
    return envelope(method, { accepted: true }) as never;
  });
}

describe("ComposerToolsPicker", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    mockCatalogRequests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("hides built-ins, the attachment tool, and global-only plugin tools", async () => {
    const tools = toolSnapshot(FULL_TOOLS, ["read", "bash", "shelljob", "piabyss_memo"]);
    useAppStore.getState().applySessionSnapshot(session(tools));
    render(<ComposerToolsPicker />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tools for this conversation" }));

    const menu = screen.getByRole("menu", { name: "Conversation tools" });
    expect(menu).toBeInTheDocument();
    // Only the workspace-toggleable plugin group remains visible.
    expect(screen.getByRole("menuitemcheckbox", { name: /后台 Shell/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /备忘录/ })).not.toBeInTheDocument();
    for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(screen.queryByRole("menuitemcheckbox", { name: builtin })).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "read_attachment" }),
    ).not.toBeInTheDocument();
  });

  it("groups a plugin's tools into one switch row (not one row per tool)", async () => {
    const tools = toolSnapshot(FULL_TOOLS, ["shelljob", "shell_wait"]);
    useAppStore.getState().applySessionSnapshot(session(tools));
    render(<ComposerToolsPicker />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tools for this conversation" }));

    // shelljob + shell_wait share one plugin row (checked: all tools active).
    const row = screen.getByRole("menuitemcheckbox", { name: /后台 Shell/ });
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-checked", "true");
    // One row total for the plugin, not two tool rows.
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(1);
  });

  it("shows no counter until the user toggles a group, then shows x/x", async () => {
    const tools = toolSnapshot(FULL_TOOLS, ["read", "bash", "shelljob"]);
    useAppStore.getState().applySessionSnapshot(session(tools));
    mockCatalogRequests((method) =>
      method === "agent.setActiveTools"
        ? toolSnapshot(FULL_TOOLS, ["read", "bash"])
        : undefined,
    );
    render(<ComposerToolsPicker />);

    const trigger = screen.getByRole("button", { name: "Tools for this conversation" });
    // Before any modification: icon-only trigger, no counter.
    expect(trigger).not.toHaveTextContent("/");

    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(screen.getByRole("menuitemcheckbox", { name: /后台 Shell/ }));

    // After toggling: visible enabled/total plugin-group ratio.
    await vi.waitFor(() => expect(trigger).toHaveTextContent("0/1"));
  });

  it("toggles the whole plugin group and preserves hidden active tools", async () => {
    const request = mockCatalogRequests();
    const tools = toolSnapshot(FULL_TOOLS, ["read", "bash", "shelljob", "piabyss_memo"]);
    useAppStore.getState().applySessionSnapshot(session(tools));
    render(<ComposerToolsPicker />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tools for this conversation" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /后台 Shell/ }));

    await vi.waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "agent.setActiveTools");
      expect(call).toBeDefined();
      // Group semantics: not every tool was active (shell_wait off), so the
      // click enables the whole plugin group. read/bash stay active (hidden
      // but preserved); read_attachment is never sent (Host re-appends it).
      expect(call![2]).toEqual({
        names: ["read", "bash", "piabyss_memo", "shelljob", "shell_wait"],
      });
    });
  });

  it("enabling a group activates every tool of the plugin", async () => {
    const request = mockCatalogRequests();
    const tools = toolSnapshot(FULL_TOOLS, ["read", "bash"]);
    useAppStore.getState().applySessionSnapshot(session(tools));
    render(<ComposerToolsPicker />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tools for this conversation" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /后台 Shell/ }));

    await vi.waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "agent.setActiveTools");
      expect(call).toBeDefined();
      // Enabling the group submits all of the plugin's tools.
      expect(call![2]).toEqual({ names: ["read", "bash", "shelljob", "shell_wait"] });
    });
  });

  it("falls back to the plugin registry name when the tool has no label", async () => {
    const tools = toolSnapshot(
      [
        {
          name: "shell_wait",
          sourcePath: SHELLJOB_SOURCE,
        },
      ],
      [],
    );
    useAppStore.getState().applySessionSnapshot(session(tools));
    render(<ComposerToolsPicker />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tools for this conversation" }));
    // Registry name (后台 Shell) renders even without a tool-level label;
    // the row carries the registry icon prefix.
    expect(screen.getByRole("menuitemcheckbox", { name: /后台 Shell/ })).toBeInTheDocument();
  });
});
