import { describe, expect, it } from "vitest";
import {
  buildAskUserQuestionTool,
  buildSelectPlan,
  createAskUserQuestionActivationExtension,
  CUSTOM_ROW_LABEL,
  isAskUserQuestionEnabled,
  MAX_PREVIEW_LENGTH,
  resolveSelection,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestion,
  type AskUserParams,
} from "./ask-user-question-tool.js";
import { MAX_EXTENSION_UI_OPTION_PREVIEW_LENGTH } from "@piabyss/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const QUESTION: AskUserQuestion = {
  question: "Which container shape should the session tree take?",
  header: "Layout",
  options: [
    {
      label: "Right drawer",
      description: "Slide the tree in from the right.",
      preview: "┌─ chat ────┐ ┌─ tree ──┐\n│ user: ... │ │ B ←     │\n└───────────┘ └─────────┘",
    },
    { label: "Centered modal", description: "Keep the modal, polish it." },
    { label: "Top strip", description: "Collapse into a strip above the chat." },
  ],
};

afterEach(() => {
  delete process.env.PIABYSS_ASK_USER_TEST_DIR;
});

describe("buildSelectPlan", () => {
  it("maps every select value back to its option index", () => {
    const plan = buildSelectPlan(QUESTION);
    expect(plan.values).toHaveLength(QUESTION.options.length + 1);
    expect(plan.values.at(-1)).toBe(CUSTOM_ROW_LABEL);
    for (const [index, option] of QUESTION.options.entries()) {
      expect(plan.byValue.get(option.label)).toBe(index);
    }
    expect(plan.byValue.has(CUSTOM_ROW_LABEL)).toBe(false);
  });

  it("carries description and preview through piabyss option details", () => {
    const plan = buildSelectPlan(QUESTION);
    expect(plan.optionDetails[0]).toEqual({
      id: "Right drawer",
      description: "Slide the tree in from the right.",
      preview: QUESTION.options[0]!.preview,
    });
    // Preview-less options omit the key entirely rather than sending undefined.
    expect("preview" in plan.optionDetails[1]!).toBe(false);
    expect(plan.optionDetails).toHaveLength(QUESTION.options.length);
  });

  it("keeps duplicate labels distinct so selection stays unambiguous", () => {
    const duplicated: AskUserQuestion = {
      ...QUESTION,
      options: [
        { label: "Same", description: "first" },
        { label: "Same", description: "second" },
      ],
    };
    const plan = buildSelectPlan(duplicated);
    expect(new Set(plan.values).size).toBe(plan.values.length);
    expect(plan.byValue.get("Same")).toBe(0);
    expect(plan.byValue.get("Same (2)")).toBe(1);
  });

  it("bounds previews to the tool's own cap, below the protocol ceiling", () => {
    const huge: AskUserQuestion = {
      ...QUESTION,
      options: [
        {
          label: "Big",
          description: "d",
          preview: "x".repeat(MAX_PREVIEW_LENGTH + 50),
        },
        { label: "Small", description: "d" },
      ],
    };
    const plan = buildSelectPlan(huge);
    expect(plan.optionDetails[0]!.preview).toHaveLength(MAX_PREVIEW_LENGTH);
    // The trusted tool cap must never exceed the protocol's hard ceiling, or the
    // request would be rejected by the Desktop-side validator.
    expect(MAX_PREVIEW_LENGTH).toBeLessThanOrEqual(MAX_EXTENSION_UI_OPTION_PREVIEW_LENGTH);
  });
});

describe("resolveSelection", () => {
  const plan = buildSelectPlan(QUESTION);

  it("resolves an option label to an option answer", () => {
    const result = resolveSelection(plan, QUESTION, 0, "Centered modal");
    expect(result).toEqual({
      answer: {
        questionIndex: 0,
        question: QUESTION.question,
        kind: "option",
        answer: "Centered modal",
      },
    });
  });

  it("routes the sentinel row to the freeform follow-up", () => {
    expect(resolveSelection(plan, QUESTION, 0, CUSTOM_ROW_LABEL)).toEqual({ freeform: true });
  });

  it("treats an unrecognized value as the user's typed answer", () => {
    const result = resolveSelection(plan, QUESTION, 2, "do it my way");
    expect(result).toEqual({
      answer: {
        questionIndex: 2,
        question: QUESTION.question,
        kind: "custom",
        answer: "do it my way",
      },
    });
  });
});

describe("ask_user_question tool", () => {
  function fakeContext(selectResult: string | undefined, inputResult?: string) {
    const selects: Array<{ title: string; values: string[]; piabyss: unknown }> = [];
    const inputs: string[] = [];
    return {
      selects,
      inputs,
      ctx: {
        ui: {
          select: async (title: string, values: string[], options?: { piabyss?: unknown }) => {
            selects.push({ title, values, piabyss: options?.piabyss });
            return selectResult;
          },
          input: async (title: string) => {
            inputs.push(title);
            return inputResult;
          },
        },
      },
    };
  }

  it("returns the option answer and echoes the question", async () => {
    const { ctx, selects } = fakeContext("Top strip");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-1",
      { questions: [QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]!.title).toBe(`[Layout] ${QUESTION.question}`);
    expect(result.details).toEqual({
      answers: [
        {
          questionIndex: 0,
          question: QUESTION.question,
          kind: "option",
          answer: "Top strip",
        },
      ],
      cancelled: false,
    });
  });

  it("asks a follow-up input for the sentinel row", async () => {
    const { ctx, inputs } = fakeContext(CUSTOM_ROW_LABEL, "something else");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-2",
      { questions: [QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(inputs).toHaveLength(1);
    expect(result.details).toMatchObject({
      cancelled: false,
      answers: [expect.objectContaining({ kind: "custom", answer: "something else" })],
    });
  });

  it("treats a dismissed dialog as cancelled and keeps prior answers", async () => {
    const { ctx } = fakeContext(undefined);
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-3",
      { questions: [QUESTION] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(result.details).toEqual({ answers: [], cancelled: true });
  });

  it("walks multi-select questions through the numeric input primitive", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const { ctx, selects, inputs } = fakeContext(undefined, "1,3");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-4",
      { questions: [multi] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    // Multi-select never opens the select dialog.
    expect(selects).toHaveLength(0);
    expect(inputs).toHaveLength(1);
    expect(result.details).toMatchObject({
      cancelled: false,
      answers: [
        expect.objectContaining({ kind: "multi", selected: ["Right drawer", "Top strip"] }),
      ],
    });
  });

  it("preserves a typed non-numeric multi-select answer verbatim", async () => {
    const multi: AskUserQuestion = { ...QUESTION, multiSelect: true };
    const { ctx } = fakeContext(undefined, "none of the above");
    const tool = buildAskUserQuestionTool();
    const result = await tool.execute(
      "call-5",
      { questions: [multi] } satisfies AskUserParams,
      undefined,
      undefined,
      ctx as never,
    );
    expect(result.details).toMatchObject({
      answers: [expect.objectContaining({ kind: "custom", answer: "none of the above" })],
    });
  });
});

describe("ask_user_question activation", () => {
  function fakePi(active: string[]) {
    const calls: string[][] = [];
    return {
      calls,
      pi: {
        getActiveTools: () => [...active],
        setActiveTools: (next: string[]) => {
          active = [...next];
          calls.push([...next]);
        },
        on: (_event: string, handler: () => void) => {
          handlers.push(handler);
        },
      },
    };
  }
  const handlers: Array<() => void> = [];

  it("adds the tool before every turn when enabled", () => {
    handlers.length = 0;
    const { pi, calls } = fakePi(["read"]);
    createAskUserQuestionActivationExtension(() => true)(pi as never);
    handlers[0]!();
    expect(calls.at(-1)).toEqual(["read", ASK_USER_QUESTION_TOOL_NAME]);
  });

  it("removes the tool when disabled", () => {
    handlers.length = 0;
    const { pi, calls } = fakePi(["read", ASK_USER_QUESTION_TOOL_NAME]);
    createAskUserQuestionActivationExtension(() => false)(pi as never);
    handlers[0]!();
    expect(calls.at(-1)).toEqual(["read"]);
  });

  it("leaves the active set untouched when already in the target state", () => {
    handlers.length = 0;
    const { pi, calls } = fakePi(["read", ASK_USER_QUESTION_TOOL_NAME]);
    createAskUserQuestionActivationExtension(() => true)(pi as never);
    handlers[0]!();
    expect(calls).toEqual([]);
  });

  it("reads the setting from settings.json, defaulting to enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "piabyss-ask-user-"));
    try {
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ askUserQuestionEnabled: false }));
      expect(isAskUserQuestionEnabled(dir)).toBe(false);
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ askUserQuestionEnabled: true }));
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
      writeFileSync(join(dir, "settings.json"), "{ not json");
      expect(isAskUserQuestionEnabled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
