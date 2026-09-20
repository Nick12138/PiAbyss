/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { InjectedReferenceChip } from "./InjectedReferenceChip";
import type { InjectedReference } from "./injected-references";

function reference(overrides: Partial<InjectedReference> = {}): InjectedReference {
  return {
    kind: "memo",
    title: "修复登录按钮",
    body: "# 修复登录按钮\n\n点击没反应。",
    raw: "<piabyss-memo>…</piabyss-memo>",
    ...overrides,
  };
}

afterEach(cleanup);

describe("InjectedReferenceChip", () => {
  it("shows an @ caption instead of the raw prompt and expands on demand", async () => {
    const user = userEvent.setup();
    render(<InjectedReferenceChip reference={reference()} />);

    const chip = screen.getByRole("button", { name: /@Memo · 修复登录按钮/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/点击没反应。/)).toBeNull();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/点击没反应。/)).toBeVisible();

    await user.click(chip);
    expect(screen.queryByText(/点击没反应。/)).toBeNull();
  });

  it("labels each injected kind", () => {
    const { unmount } = render(
      <InjectedReferenceChip
        reference={reference({ kind: "schedule-preamble", title: "", body: "你是助手。" })}
      />,
    );
    expect(screen.getByRole("button", { name: /@Schedule prompt/ })).toBeVisible();
    unmount();

    render(
      <InjectedReferenceChip
        reference={reference({ kind: "memo-result", title: "", body: "做完了" })}
      />,
    );
    expect(screen.getByRole("button", { name: /@Memo summary/ })).toBeVisible();
  });
});
