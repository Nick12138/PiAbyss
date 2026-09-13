/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionUiOption } from "@piabyss/protocol";
import { hasOptionPreviews, OptionPreview } from "./OptionPreview";

const ASCII = [
  "┌─ chat ────┐ ┌─ tree ──┐",
  "│ user: ... │ │ B <-    │",
  "└───────────┘ └─────────┘",
].join("\n");

function option(overrides: Partial<ExtensionUiOption> = {}): ExtensionUiOption {
  return { id: "opt-1", label: "Right drawer", description: "d", ...overrides };
}

afterEach(cleanup);

describe("hasOptionPreviews", () => {
  it("detects any option carrying preview content", () => {
    expect(hasOptionPreviews([option(), option({ preview: ASCII })])).toBe(true);
    expect(hasOptionPreviews([option(), option()])).toBe(false);
    expect(hasOptionPreviews([])).toBe(false);
  });
});

describe("OptionPreview", () => {
  it("renders ASCII art verbatim in a monospace block", () => {
    const { container } = render(
      <OptionPreview option={option({ preview: ASCII })} fallbackLabel="Preview" />,
    );
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    // Exact alignment must survive: no trimming, no reflow, no markdown.
    expect(pre!.textContent).toBe(ASCII);
  });

  it("unwraps a fenced block so the fence characters never render", () => {
    const fenced = `\`\`\`\n${ASCII}\n\`\`\``;
    const { container } = render(
      <OptionPreview option={option({ preview: fenced })} fallbackLabel="Preview" />,
    );
    const pre = container.querySelector("pre");
    expect(pre!.textContent).toBe(ASCII);
    expect(pre!.textContent).not.toContain("```");
  });

  it("falls back to a placeholder when the option has no preview", () => {
    render(<OptionPreview option={option()} fallbackLabel="Preview" />);
    expect(screen.getByText("No preview for this option.")).toBeVisible();
  });

  it("collapses long previews behind an expand control", async () => {
    const long = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const { container } = render(
      <OptionPreview option={option({ preview: long })} fallbackLabel="Preview" />,
    );
    expect(container.querySelector("pre")!.textContent!.split("\n")).toHaveLength(10);

    await userEvent.click(screen.getByRole("button", { name: /Show 20 more lines/i }));
    expect(container.querySelector("pre")!.textContent!.split("\n")).toHaveLength(30);
  });

  it("does not offer expansion for short previews", () => {
    render(<OptionPreview option={option({ preview: ASCII })} fallbackLabel="Preview" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
