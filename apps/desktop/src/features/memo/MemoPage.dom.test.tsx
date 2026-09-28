/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, MemoNote, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { MemoPage } from "./MemoPage";

const mocks = vi.hoisted(() => ({
  listMemoNotes: vi.fn(),
  updateMemoNote: vi.fn(),
  createMemoNote: vi.fn(),
  deleteMemoNote: vi.fn(),
  optimizeMemo: vi.fn(),
  getMemoDraft: vi.fn(),
  setMemoDraft: vi.fn(),
  clearMemoDraft: vi.fn(),
  readMemoImageDataUrl: vi.fn(),
}));

vi.mock("./memo-client", () => mocks);

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.82.1",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const workspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/workspace",
  canonicalCwd: "/workspace",
  revision: 1,
  servicesReady: true,
};

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  return {
    id: "memo-1",
    type: "memo",
    title: "手动完成一条",
    contentMd: "手动完成一条\n正文",
    status: "open",
    sessionId: null,
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    result: null,
    deletedAt: null,
    ...overrides,
  };
}

const openNote = note();
const runningNote = note({
  id: "memo-2",
  title: "进行中一条",
  status: "in_progress",
  sessionId: "s1",
});

describe("MemoPage 手动标记完成", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listMemoNotes.mockResolvedValue([openNote, runningNote]);
    mocks.getMemoDraft.mockResolvedValue(null);
    mocks.setMemoDraft.mockResolvedValue(null);
    mocks.clearMemoDraft.mockResolvedValue(undefined);
    mocks.createMemoNote.mockImplementation(async () => openNote);
    mocks.deleteMemoNote.mockResolvedValue(undefined);
    mocks.optimizeMemo.mockResolvedValue({ contentMd: "", type: "memo", workspaceId: null });
    mocks.readMemoImageDataUrl.mockResolvedValue("");
    mocks.updateMemoNote.mockImplementation(async (id: string, patch: Partial<MemoNote>) => {
      const source = [openNote, runningNote].find((entry) => entry.id === id) ?? note({ id });
      return { ...source, ...patch };
    });
    useAppStore.setState({
      host,
      workspace,
      session: null,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
      desktopSettings: null,
    });
  });

  afterEach(() => cleanup());

  it("lets a 待处理 record be completed from its list row", async () => {
    render(<MemoPage />);

    const row = (await screen.findByText("手动完成一条")).closest("li");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark done" }));

    await waitFor(() => {
      expect(mocks.updateMemoNote).toHaveBeenCalledWith("memo-1", { status: "done" });
    });
  });

  it("keeps a 进行中 record completable from its list row (spinner while idle)", async () => {
    render(<MemoPage />);
    await screen.findByText("手动完成一条");

    // 进行中记录在「进行中」页签下，行内平时显示加载图标，但仍可标记完成。
    fireEvent.click(screen.getByRole("tab", { name: /In progress/ }));
    const row = (await screen.findByText("进行中一条")).closest("li");
    expect(row?.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark done" }));

    await waitFor(() => {
      expect(mocks.updateMemoNote).toHaveBeenCalledWith("memo-2", { status: "done" });
    });
  });

  it("keeps a 进行中 record completable from its detail header", async () => {
    render(<MemoPage />);
    await screen.findByText("手动完成一条");

    fireEvent.click(screen.getByRole("tab", { name: /In progress/ }));
    fireEvent.click(await screen.findByTestId("memo-list-item"));

    fireEvent.click(await screen.findByTestId("memo-detail-complete"));

    await waitFor(() => {
      expect(mocks.updateMemoNote).toHaveBeenCalledWith("memo-2", { status: "done" });
    });
  });
});
