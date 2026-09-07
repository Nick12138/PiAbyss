/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import type {
  GitStatusSnapshot,
  HostResponseEnvelope,
  HostStatusSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import { publishValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { useAppStore } from "../../lib/stores/app-store";
import { MenuHost } from "../../components/Menu";
import { ChangesPanel } from "./ChangesPanel";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: (index: number) => number;
  }) => ({
    getTotalSize: () =>
      Array.from({ length: count }, (_, index) => estimateSize(index)).reduce(
        (sum, size) => sum + size,
        0,
      ),
    getVirtualItems: () => {
      let start = 0;
      return Array.from({ length: count }, (_, index) => {
        const size = estimateSize(index);
        const item = { key: index, index, start, size };
        start += size;
        return item;
      });
    },
  }),
}));

const host = {
  hostInstanceId: "00000000-0000-4000-8000-000000000101",
} as HostStatusSnapshot;
const workspace = {
  id: "00000000-0000-4000-8000-000000000201",
  revision: 3,
  canonicalCwd: "/repo/apps/desktop",
} as WorkspaceSnapshot;

function status(
  overrides: Partial<Extract<GitStatusSnapshot, { state: "ready" }>> = {},
): Extract<GitStatusSnapshot, { state: "ready" }> {
  return {
    state: "ready",
    revision: 7,
    repositoryRoot: "/repo",
    workspaceIsRepositoryRoot: false,
    branch: "main",
    detached: false,
    unborn: false,
    headSha: "a".repeat(40),
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    indexGeneration: "b".repeat(64),
    warnings: [],
    files: [
      {
        path: "src/app.ts",
        staged: "modified",
        unstaged: "modified",
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
    ],
    ...overrides,
  };
}

function success<M extends string>(method: M, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: crypto.randomUUID(),
    method,
    hostInstanceId: host.hostInstanceId,
    workspaceId: workspace.id,
    workspaceRevision: workspace.revision,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    ok: true,
    result,
  } as unknown as HostResponseEnvelope;
}

let request: MockInstance<typeof hostClient.request>;

beforeEach(() => {
  useAppStore.setState({ host, workspace, desktopSettings: { language: "en" } as never });
  request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "git.setWatching")
      return success(method, { watching: true, snapshot: status() }) as never;
    if (method === "git.getStatus") return success(method, status()) as never;
    throw new Error(`Unexpected method ${method}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChangesPanel", () => {
  it("watches only while visible and renders staged plus unstaged groups", async () => {
    const { rerender } = render(<ChangesPanel visible />);

    expect(await screen.findByText("Staged Changes")).toBeVisible();
    expect(screen.getByText("Changes", { selector: "span" })).toBeVisible();
    expect(
      screen.getByText(
        "The repository root is above this workspace. Changes from the entire repository are shown and can be staged.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Changes: src/app.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();

    rerender(<ChangesPanel visible={false} />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "git.setWatching",
        expect.any(Object),
        { enabled: false },
        12_000,
      );
    });
  });

  it("loads a file diff and returns to the list", async () => {
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: status() }) as never;
      if (method === "git.getDiff")
        return success(method, {
          path: "src/app.ts",
          area: "unstaged",
          patch: "@@ -1 +1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
          binary: false,
          truncated: false,
          contentGeneration: "c".repeat(64),
        }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Changes: src/app.ts" }));
    expect(await screen.findByText("+new")).toBeVisible();
    expect(screen.getByText("-old")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to changes" }));
    expect(screen.getByText("Staged Changes")).toBeVisible();
  });

  it("stages a file and commits staged content with Ctrl+Enter", async () => {
    const stagedOnly = status({
      revision: 8,
      files: [
        {
          path: "src/app.ts",
          staged: "modified",
          unstaged: null,
          conflict: false,
          submodule: false,
          pathSupported: true,
        },
      ],
    });
    const clean = status({ revision: 9, indexGeneration: "d".repeat(64), files: [] });
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, {
          watching: true,
          snapshot: status({ files: [{ ...status().files[0]!, staged: null }] }),
        }) as never;
      if (method === "git.stage")
        return success(method, { applied: true, snapshot: stagedOnly }) as never;
      if (method === "git.commit")
        return success(method, {
          applied: true,
          commitSha: "deadbeef" + "0".repeat(32),
          snapshot: clean,
        }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Stage src/app.ts" }));
    expect(await screen.findByText("Staged Changes")).toBeVisible();
    const message = screen.getByRole("textbox", { name: "Commit message" });
    await user.type(message, "feat: update app");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.commit",
        expect.any(Object),
        { message: "feat: update app", expectedIndexGeneration: stagedOnly.indexGeneration },
        65_000,
      ),
    );
    expect(await screen.findByText("Committed deadbeef")).toBeVisible();
    expect(screen.getByText("No changes")).toBeVisible();
  });

  it("fills the composer from a generated commit message", async () => {
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: status() }) as never;
      if (method === "git.generateCommitMessage")
        return success(method, { message: "feat: update app" }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Generate" }));

    const message = screen.getByRole("textbox", { name: "Commit message" });
    await waitFor(() => expect(message).toHaveValue("feat: update app"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.generateCommitMessage",
        expect.any(Object),
        { expectedIndexGeneration: status().indexGeneration },
        60_000,
      ),
    );
  });

  it("stages and unstages all changes from the group headers", async () => {
    const unstagedOnly = status({
      files: [{ ...status().files[0]!, staged: null }],
    });
    const stagedOnly = status({
      revision: 8,
      files: [{ ...status().files[0]!, unstaged: null }],
    });
    const finalUnstaged = status({
      revision: 9,
      files: [{ ...status().files[0]!, staged: null }],
    });
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: unstagedOnly }) as never;
      if (method === "git.stageAll")
        return success(method, { applied: true, snapshot: stagedOnly }) as never;
      if (method === "git.unstageAll")
        return success(method, { applied: true, snapshot: finalUnstaged }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Stage all changes" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.stageAll",
        expect.any(Object),
        { expectedRevision: unstagedOnly.revision },
        32_000,
      ),
    );

    await user.click(await screen.findByRole("button", { name: "Unstage all changes" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.unstageAll",
        expect.any(Object),
        { expectedRevision: stagedOnly.revision },
        32_000,
      ),
    );
    expect(await screen.findByRole("button", { name: "Stage all changes" })).toBeVisible();
  });

  it("confirms discard and preserves the staged version", async () => {
    const stagedOnly = status({
      revision: 8,
      files: [{ ...status().files[0]!, unstaged: null }],
    });
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: status() }) as never;
      if (method === "git.discard")
        return success(method, { applied: true, snapshot: stagedOnly }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Discard changes in src/app.ts" }));
    expect(screen.getByRole("dialog", { name: "Discard changes?" })).toBeVisible();
    expect(screen.getByText("The staged version will be preserved.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.discard",
        expect.any(Object),
        { path: "src/app.ts", expectedRevision: 7 },
        32_000,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Changes: src/app.ts" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();
  });

  it("ignores status events from another workspace", async () => {
    render(<ChangesPanel visible />);
    expect(await screen.findByRole("button", { name: "Changes: src/app.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();

    act(() =>
      publishValidatedHostEvent({
        protocolVersion: 1,
        event: "git.changed",
        sequence: 2,
        timestamp: 2,
        hostInstanceId: host.hostInstanceId,
        workspaceId: "00000000-0000-4000-8000-000000000999",
        workspaceRevision: workspace.revision,
        sessionId: null,
        sessionRevision: 0,
        packageRevision: 0,
        payload: { snapshot: status({ files: [] }) },
      }),
    );
    expect(screen.getByRole("button", { name: "Changes: src/app.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();
  });

  it("stages a reviewed hunk through its structured identity", async () => {
    const unstaged = status({ files: [{ ...status().files[0]!, staged: null }] });
    const staged = status({
      revision: 8,
      files: [{ ...status().files[0]!, unstaged: null }],
    });
    const diff = {
      path: "src/app.ts",
      area: "unstaged",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      binary: false,
      truncated: false,
      contentGeneration: "c".repeat(64),
      hunks: [
        {
          id: "d".repeat(64),
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          additions: 1,
          deletions: 1,
        },
      ],
      hunkOperations: ["stage", "discard"],
    } as const;
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: unstaged }) as never;
      if (method === "git.getDiff") return success(method, diff) as never;
      if (method === "git.mutateHunk")
        return success(method, { applied: true, snapshot: staged }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Changes: src/app.ts" }));
    await user.click(await screen.findByRole("button", { name: "Stage hunk" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.mutateHunk",
        expect.any(Object),
        {
          path: "src/app.ts",
          area: "unstaged",
          hunkId: "d".repeat(64),
          operation: "stage",
          expectedRevision: unstaged.revision,
          expectedContentGeneration: diff.contentGeneration,
        },
        32_000,
      ),
    );
    expect(await screen.findByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();
  });

  it("confirms destructive hunk discard", async () => {
    const unstaged = status({ files: [{ ...status().files[0]!, staged: null }] });
    const clean = status({ revision: 8, files: [] });
    const diff = {
      path: "src/app.ts",
      area: "unstaged",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      binary: false,
      truncated: false,
      contentGeneration: "c".repeat(64),
      hunks: [
        {
          id: "e".repeat(64),
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          additions: 1,
          deletions: 1,
        },
      ],
      hunkOperations: ["stage", "discard"],
    } as const;
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: unstaged }) as never;
      if (method === "git.getDiff") return success(method, diff) as never;
      if (method === "git.mutateHunk")
        return success(method, { applied: true, snapshot: clean }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Changes: src/app.ts" }));
    await user.click(await screen.findByRole("button", { name: "Discard hunk" }));
    const dialog = screen.getByRole("dialog", { name: "Discard this hunk?" });
    expect(dialog).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Discard hunk" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.mutateHunk",
        expect.any(Object),
        expect.objectContaining({ hunkId: "e".repeat(64), operation: "discard" }),
        32_000,
      ),
    );
  });

  it("switches and creates local branches from the shared branch menu", async () => {
    const feature = status({ revision: 8, branch: "feature/git", ahead: 0, behind: 0 });
    const created = status({ revision: 9, branch: "feature/new", ahead: 0, behind: 0 });
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: status() }) as never;
      if (method === "git.listBranches")
        return success(method, {
          statusRevision: 7,
          current: "main",
          detached: false,
          branches: [
            { name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 2 },
            { name: "feature/git", current: false, upstream: null, ahead: 0, behind: 0 },
          ],
          truncated: false,
        }) as never;
      if (method === "git.switchBranch")
        return success(method, { applied: true, snapshot: feature }) as never;
      if (method === "git.createBranch")
        return success(method, { applied: true, snapshot: created }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(
      <>
        <ChangesPanel visible />
        <MenuHost />
      </>,
    );

    await user.click(await screen.findByRole("button", { name: "Choose branch" }));
    await user.click(await screen.findByRole("menuitem", { name: "feature/git" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.switchBranch",
        expect.any(Object),
        { name: "feature/git", expectedRevision: 7 },
        32_000,
      ),
    );

    await user.click(screen.getByRole("button", { name: "Choose branch" }));
    await user.click(await screen.findByRole("menuitem", { name: "Create branch" }));
    await user.type(screen.getByRole("textbox", { name: "Branch name" }), "feature/new");
    await user.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "git.createBranch",
        expect.any(Object),
        { name: "feature/new", expectedRevision: feature.revision },
        32_000,
      ),
    );
  });

  it("browses history and opens a first-parent commit diff", async () => {
    const commit = {
      sha: "f".repeat(40),
      shortSha: "ffffffff",
      parents: ["a".repeat(40)],
      authorName: "PiAbyss Test",
      authoredAt: "2026-08-02T12:00:00+08:00",
      subject: "History change",
      refs: ["HEAD -> main"],
    };
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching")
        return success(method, { watching: true, snapshot: status() }) as never;
      if (method === "git.listHistory")
        return success(method, { commits: [commit], nextCursor: null }) as never;
      if (method === "git.getCommitDiff")
        return success(method, {
          commitSha: commit.sha,
          parentSha: commit.parents[0],
          patch: "@@ -0,0 +1 @@\n+history change",
          additions: 1,
          deletions: 0,
          binary: false,
          truncated: false,
        }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "Open commit: History change" }));
    expect(await screen.findByText("+history change")).toBeVisible();
    expect(screen.getByText("ffffffff")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to history" }));
    expect(screen.getByRole("button", { name: "Open commit: History change" })).toBeVisible();
  });
});
