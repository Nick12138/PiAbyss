export type BuiltinCommand = {
  name: string;
  description: string;
  argumentHint?: string;
};

/** Slash commands PiAbyss executes locally instead of sending to the model.
 * A subset of Pi's built-in command set; grows as PiAbyss implements more. */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
  },
  {
    name: "session",
    description: "Show session info and stats",
  },
  {
    name: "tree",
    description: "Navigate session tree (switch branches)",
  },
  {
    name: "fork",
    description: "Create a new fork from a previous user message",
  },
  {
    name: "export",
    description: "Export session to a file (HTML default)",
    argumentHint: "[html|jsonl]",
  },
  {
    name: "login",
    description: "Sign in to a model provider (opens Settings → Providers)",
  },
];

export type BuiltinCommandMatch = { name: string; args?: string };

/** Match a draft against BUILTIN_COMMANDS. The whole draft must be `/name`
 * or `/name args` — unknown commands fall through to the model unchanged. */
export function matchBuiltinCommand(text: string): BuiltinCommandMatch | null {
  const match = /^\/(\S+)([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  const name = match[1];
  if (!BUILTIN_COMMANDS.some((command) => command.name === name)) return null;
  const args = match[2].trim();
  return args ? { name, args } : { name };
}
