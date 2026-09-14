/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramRenameDialog } from "./TelegramRenameDialog";

describe("TelegramRenameDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("prefills the current name and confirms the edited value", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <TelegramRenameDialog currentName="我的 Bot" onCancel={vi.fn()} onConfirm={onConfirm} />,
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("我的 Bot");
    await user.clear(input);
    await user.type(input, "工作机器人");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onConfirm).toHaveBeenCalledWith("工作机器人");
  });
});
