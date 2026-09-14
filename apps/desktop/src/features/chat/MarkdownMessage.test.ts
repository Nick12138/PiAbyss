import { describe, expect, it } from "vitest";
import {
  codeLineCount,
  deferIncompleteMermaid,
  isSafeExternalUrl,
  isSafeFootnoteFragment,
  mermaidFenceSignature,
  sanitizeAgentText,
  updateStreamingSplit,
} from "./markdown-utils";

describe("updateStreamingSplit", () => {
  const long = (line: string) => `${line}${" .".repeat(400)}`;

  it("keeps short texts whole", () => {
    const split = updateStreamingSplit(null, "short text");
    expect(split.frozen).toEqual([]);
    expect(split.tail).toBe("short text");
  });

  it("freezes all but the trailing two segments", () => {
    const text = [long("one"), long("two"), long("three"), long("four"), long("five")].join("\n\n");
    const split = updateStreamingSplit(null, text);
    expect(split.frozen).toEqual([long("one"), long("two"), long("three")]);
    expect(split.tail).toBe(`${long("four")}\n\n${long("five")}`);
    // frozenText is the exact source prefix covered by the frozen segments.
    expect(text.startsWith(split.frozenText)).toBe(true);
    expect(split.frozenText.length + split.tail.length <= text.length).toBe(true);
  });

  it("reuses frozen segment strings by reference on append-only updates", () => {
    const base = [long("one"), long("two"), long("three"), long("four")].join("\n\n");
    const first = updateStreamingSplit(null, base);
    const appended = updateStreamingSplit(first, `${base}\n\n${long("five")}`);
    expect(appended.frozen.slice(0, first.frozen.length)).toEqual(first.frozen);
    for (let index = 0; index < first.frozen.length; index += 1) {
      expect(appended.frozen[index]).toBe(first.frozen[index]);
    }
    expect(appended.tail).toBe(`${long("four")}\n\n${long("five")}`);
  });

  it("never splits inside a fenced code block", () => {
    const fence = ["```ts", long("code"), "", long("more code"), "```"].join("\n");
    const text = [long("intro"), fence, long("outro"), long("outro2"), long("outro3")].join("\n\n");
    const split = updateStreamingSplit(null, text);
    // The whole fence stays inside one segment.
    const joined = [...split.frozen, split.tail].join("\n\n");
    expect(joined).toContain("```ts");
    expect(joined.match(/```ts/g)?.length).toBe(1);
    const fenceSegment = [...split.frozen, split.tail].find((segment) => segment.includes("```ts"));
    expect(fenceSegment).toContain(long("code"));
    expect(fenceSegment).toContain(long("more code"));
  });

  it("keeps an unclosed fence entirely in the live tail", () => {
    const text = [long("one"), long("two"), long("three"), "```ts", long("code")].join("\n\n");
    const split = updateStreamingSplit(null, text);
    expect(split.frozen).toEqual([long("one"), long("two")]);
    expect(split.tail.startsWith(long("three"))).toBe(true);
    expect(split.tail).toContain("```ts");
  });

  it("recomputes fully when the text is rewritten", () => {
    const base = [long("one"), long("two"), long("three"), long("four")].join("\n\n");
    const first = updateStreamingSplit(null, base);
    const rewritten = [long("changed"), long("two"), long("three"), long("four")].join("\n\n");
    const second = updateStreamingSplit(first, rewritten);
    expect(second.frozen).toEqual([long("changed"), long("two")]);
  });

  it("is idempotent for repeated renders of the same text", () => {
    const text = [long("one"), long("two"), long("three"), long("four")].join("\n\n");
    const first = updateStreamingSplit(null, text);
    expect(updateStreamingSplit(first, text)).toBe(first);
  });
});

describe("sanitizeAgentText", () => {
  it("removes ANSI decoration and internal dcp markers", () => {
    expect(
      sanitizeAgentText("\u001b[38;5;38mThinking:\u001b[39m Inspect this\n<dcp-id>m004</dcp-id>"),
    ).toBe("Inspect this\n");
  });
});

describe("safe markdown URLs", () => {
  it.each(["https://example.com/path", "http://localhost:1420/"])("allows %s", (url) =>
    expect(isSafeExternalUrl(url)).toBe(true),
  );

  it.each(["javascript:alert(1)", "file:///C:/secret", "../relative.md", "mailto:a@b.com"])(
    "rejects %s",
    (url) => expect(isSafeExternalUrl(url)).toBe(false),
  );
});

describe("codeLineCount", () => {
  it("does not count the trailing newline as another line", () => {
    expect(codeLineCount("one\ntwo\n")).toBe(2);
  });
});

describe("deferIncompleteMermaid", () => {
  it("keeps an unfinished Mermaid fence as a normal code fence", () => {
    const source = "```mermaid\nflowchart TD\n  A --> B";
    expect(deferIncompleteMermaid(source)).toBe("```text\nflowchart TD\n  A --> B");
  });

  it("does not alter a closed Mermaid fence", () => {
    const source = "```mermaid\nflowchart TD\n  A --> B\n```";
    expect(deferIncompleteMermaid(source)).toBe(source);
  });

  it("supports tilde fences and case-insensitive language names", () => {
    const source = "~~~MERMAID\nflowchart TD\n  A --> B";
    expect(deferIncompleteMermaid(source)).toBe("~~~text\nflowchart TD\n  A --> B");
  });

  it("preserves fence metadata while deferring the Mermaid language", () => {
    const source = '```mermaid title="Flow"\nflowchart TD\n  A --> B';
    expect(deferIncompleteMermaid(source)).toBe('```text title="Flow"\nflowchart TD\n  A --> B');
  });

  it("normalizes a closed uppercase fence and scans blockquotes", () => {
    const closed = "> ```MERMAID\n> flowchart TD\n>   A --> B\n> ```";
    expect(deferIncompleteMermaid(closed)).toBe("> ```mermaid\n> flowchart TD\n>   A --> B\n> ```");

    const open = "> ```mermaid\n> flowchart TD\n>   A --> B";
    expect(deferIncompleteMermaid(open)).toBe("> ```text\n> flowchart TD\n>   A --> B");
  });

  it("defers a list-continuation Mermaid fence", () => {
    const source = "- item\n\n    ```mermaid\n    flowchart TD\n      A --> B";
    expect(deferIncompleteMermaid(source)).toBe(
      "- item\n\n    ```text\n    flowchart TD\n      A --> B",
    );
  });

  it("defers every unfinished fence when sibling containers split code blocks", () => {
    const listSource = "- ```mermaid\nA\n- ```mermaid\nB";
    expect(deferIncompleteMermaid(listSource)).toBe("- ```text\nA\n- ```text\nB");

    const quoteSource = "> ```mermaid\n> A\n\noutside\n\n> ```";
    expect(deferIncompleteMermaid(quoteSource)).toBe("> ```text\n> A\n\noutside\n\n> ```");
  });

  it("follows CommonMark container order for nested lists and blockquotes", () => {
    expect(deferIncompleteMermaid("- > ```mermaid\n  > A")).toBe("- > ```text\n  > A");
    expect(deferIncompleteMermaid("- - ```mermaid\n    A")).toBe("- - ```text\n    A");
  });

  it("preserves tabs and CRLF while replacing only the language token", () => {
    const source = "> \t```MERMAID\r\n> \tflowchart TD\r\n> \t  A --> B";
    expect(deferIncompleteMermaid(source)).toBe("> \t```text\r\n> \tflowchart TD\r\n> \t  A --> B");
  });

  it("does not rewrite Mermaid-like text that is not a fenced code block", () => {
    const paragraph = "paragraph\n2. ```mermaid\n   A";
    const invalidInfo = "```mermaid`invalid\nA";
    const otherLanguage = "~~~mermaid~invalid\nA";

    expect(deferIncompleteMermaid(paragraph)).toBe(paragraph);
    expect(deferIncompleteMermaid(invalidInfo)).toBe(invalidInfo);
    expect(deferIncompleteMermaid(otherLanguage)).toBe(otherLanguage);
  });

  it("does not mistake diagram content for a closing fence", () => {
    const source = "```mermaid\nflowchart TD\n- ```";
    expect(deferIncompleteMermaid(source)).toBe("```text\nflowchart TD\n- ```");
  });

  it("signs only closed Mermaid source", () => {
    const closed = "```mermaid\nflowchart TD\n  A --> B\n```";
    expect(mermaidFenceSignature("```mermaid\nflowchart TD\n  A --> B")).toBe("none");
    expect(mermaidFenceSignature(`${closed}\ntrailing prose`)).toBe(
      mermaidFenceSignature(`${closed}\ndifferent prose`),
    );
    expect(mermaidFenceSignature(closed)).not.toBe(
      mermaidFenceSignature("```mermaid\nflowchart TD\n  A --> C\n```"),
    );
  });
});

describe("safe footnote fragments", () => {
  it("allows only generated footnote and back-reference targets", () => {
    const prefix = "piabyss-md-r0-";
    expect(isSafeFootnoteFragment("#piabyss-md-r0-fn-note", prefix)).toBe(true);
    expect(isSafeFootnoteFragment("#piabyss-md-r0-fnref-note-2", prefix)).toBe(true);
    expect(isSafeFootnoteFragment("#user-content-fn-note", prefix)).toBe(false);
    expect(isSafeFootnoteFragment("#piabyss-md-r0-fn-note/../secret", prefix)).toBe(false);
  });
});
