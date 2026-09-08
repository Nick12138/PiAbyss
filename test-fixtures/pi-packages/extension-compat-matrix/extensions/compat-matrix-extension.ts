import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as never;

export default function extensionCompatibilityMatrix(pi: ExtensionAPI) {
  let watcher: ReturnType<typeof setInterval> | undefined;
  let rendererSequence = 0;
  const messageRendererStates = new Map<string, string>();

  pi.registerProvider("matrix-provider", {
    baseUrl: "https://matrix-provider.invalid/v1",
    apiKey: "matrix-provider-key-never-real",
    api: "openai-completions",
    models: [
      {
        id: "matrix-model",
        name: "Matrix Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 2_048,
      },
    ],
  });

  pi.registerMessageRenderer("matrix-message", (message, { expanded }) => ({
    render: () => {
      const requestId = (message.details as { requestId?: unknown } | undefined)?.requestId;
      const state =
        typeof requestId === "string"
          ? (messageRendererStates.get(requestId) ?? "Matrix renderer missing state")
          : "Matrix renderer missing request";
      return [expanded ? `${state}: full report` : state];
    },
    invalidate: () => {},
  }));
  pi.registerEntryRenderer("matrix-entry", () => ({
    render: () => ["matrix entry fallback"],
    invalidate: () => {},
  }));

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("matrix-persistent", ["Matrix widget: starting"]);
    ctx.ui.setWidget("matrix-persistent", ["Matrix widget: ready"], { placement: "belowEditor" });
    ctx.ui.setStatus("matrix-watcher", "watching");
    watcher = setInterval(() => {
      ctx.ui.setStatus("matrix-watcher", "watching");
    }, 60_000);
    watcher.unref?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (watcher) clearInterval(watcher);
    watcher = undefined;
    ctx.ui.setWidget("matrix-persistent", undefined);
    ctx.ui.setStatus("matrix-watcher", undefined);
    pi.events.emit("piabyss:matrix:shutdown", { cleaned: true });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!command.includes("matrix-danger")) return undefined;
    const choice = await ctx.ui.select("Allow guarded command?", ["Allow", "Block"]);
    return choice === "Allow"
      ? undefined
      : { block: true, reason: "Blocked by matrix permission guard" };
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    const confirmed = await ctx.ui.confirm(
      "Leave this repository state?",
      "The matrix repository guard has pending state.",
    );
    return confirmed ? undefined : { cancel: true };
  });

  pi.on("turn_end", async (_event, ctx) => {
    const confirmed = await ctx.ui.confirm(
      "Background watcher approval",
      "Apply the queued background observation?",
    );
    pi.events.emit("piabyss:matrix:background-result", { confirmed });
  });

  pi.registerTool({
    name: "matrix_subagent",
    label: "Matrix Subagent",
    description: "Exercises dialog, activity, widget, and custom terminal behavior.",
    parameters: EMPTY_PARAMETERS,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.ui.setWidget("matrix-subagent", ["Subagent: waiting"]);
      ctx.ui.setStatus("matrix-subagent", "running");
      ctx.ui.notify("Matrix subagent activity", "info");
      try {
        const next = await ctx.ui.select("Subagent next step", ["Continue", "Open terminal"]);
        let terminalResult: string | undefined;
        if (next === "Open terminal") {
          terminalResult = await ctx.ui.custom<string>((tui, _theme, _keybindings, done) => ({
            render: () => ["Matrix terminal", "Press Enter to finish"],
            invalidate: () => {},
            handleInput: (data: string) => {
              if (data === "\r") done("terminal-complete");
              else tui.requestRender();
            },
          }));
        }
        return {
          content: [{ type: "text", text: next ?? "cancelled" }],
          details: { next, terminalResult },
        };
      } finally {
        ctx.ui.setWidget("matrix-subagent", undefined);
        ctx.ui.setStatus("matrix-subagent", undefined);
      }
    },
  });

  pi.registerCommand("matrix-plan", {
    description: "Exercises a planning select followed by an editor.",
    handler: async (_args, ctx) => {
      const next = await ctx.ui.select("Plan next step", ["Edit plan", "Accept plan"]);
      const plan =
        next === "Edit plan"
          ? await ctx.ui.editor("Edit matrix plan", "Initial matrix plan")
          : "Initial matrix plan";
      pi.events.emit("piabyss:matrix:plan-result", { next, plan });
    },
  });

  pi.registerCommand("matrix-large-select", {
    description: "Exercises a selector with more than 100 stable option values.",
    handler: async (_args, ctx) => {
      const options = Array.from({ length: 150 }, (_, index) => `Matrix option ${index + 1}`);
      const selected = await ctx.ui.select("Choose a matrix option", options);
      pi.events.emit("piabyss:matrix:large-result", { selected });
    },
  });

  pi.registerCommand("matrix-renderer", {
    description: "Exercises a dynamic registered message renderer.",
    handler: async () => {
      rendererSequence += 1;
      const requestId = `matrix-renderer-${rendererSequence}`;
      messageRendererStates.set(requestId, "Matrix renderer running");
      pi.sendMessage({
        customType: "matrix-message",
        content: "Matrix renderer anchor",
        display: true,
        details: { requestId },
      });
      await Promise.resolve();
      messageRendererStates.set(requestId, "Matrix renderer complete");
      pi.sendMessage({
        customType: "matrix-message",
        content: "Matrix renderer final state",
        display: false,
        details: { requestId },
      });
    },
  });
}
