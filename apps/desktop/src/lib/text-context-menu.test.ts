/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { buildTextContextMenuItems, insertTextAtSelection } from "./text-context-menu";

const t = ((key: string) => key) as never;

describe("text context-menu actions", () => {
  it("inserts at the field selection and emits a controlled input event", () => {
    const input = document.createElement("textarea");
    input.value = "hello world";
    input.setSelectionRange(6, 11);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    insertTextAtSelection(input, "PiAbyss");
    expect(input.value).toBe("hello PiAbyss");
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("disables cut/copy without a selection and appends extra actions", () => {
    const input = document.createElement("input");
    input.value = "text";
    input.setSelectionRange(0, 0);
    const items = buildTextContextMenuItems(input, t, [
      { id: "extra", label: "Extra", onSelect: vi.fn() },
    ]);
    expect(items.find((item) => item.id === "edit.cut")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "edit.copy")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "edit.paste")?.chordHint).toBeTruthy();
    expect(items.map((item) => item.id)).toContain("extra");
  });
});
