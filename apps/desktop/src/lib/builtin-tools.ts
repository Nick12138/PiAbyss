/** Built-in tools pi ships; mirrors the SDK's `allToolNames` registry.
 *
 * Single source of truth for every surface that has to tell a built-in apart
 * from a plugin-provided tool: Settings → General → 默认工具 and the composer's
 * per-conversation tools picker. A name missing here does not merely stay
 * unclassified — it leaks into the picker as a stray, user-toggleable row.
 * Keep in sync with the SDK. */
export const BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "powershell",
] as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** O(1) membership test; the picker filters a full ToolSnapshot on each render. */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

/**
 * The SDK default when `defaultTools` is absent from settings.json. On native
 * Windows the SDK also enables `powershell`; we keep it always on.
 */
export const DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "powershell"];

/**
 * `powershell` is forced on and hidden: it only widens the model's fallback
 * path on Windows, and there is no reason for users to toggle it. Every UI
 * surface that renders a tool list must exclude these.
 */
export const HIDDEN_ALWAYS_ON_TOOLS: readonly BuiltinTool[] = ["powershell"];

/** Tools a user may actually see and toggle. */
export const VISIBLE_TOOLS: readonly BuiltinTool[] = BUILTIN_TOOLS.filter(
  (tool) => !HIDDEN_ALWAYS_ON_TOOLS.includes(tool),
);
