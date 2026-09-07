import type { DesktopSettings } from "@piabyss/protocol";
import type { AppCommand } from "./registry";

export type ShortcutOverrides = NonNullable<DesktopSettings["shortcutOverrides"]>;

const MODIFIER_TOKENS = new Set(["mod", "shift", "alt"]);
const MODIFIER_KEYS = new Set(["meta", "control", "shift", "alt"]);
const NAMED_KEYS = new Set([
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "backspace",
  "delete",
  "end",
  "enter",
  "escape",
  "home",
  "pagedown",
  "pageup",
  "plus",
  "space",
  "tab",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

function hasOwn(overrides: ShortcutOverrides | undefined, commandId: string): boolean {
  return Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, commandId));
}

function keyToken(key: string): string | null {
  const normalized = key.toLocaleLowerCase();
  if (normalized === " ") return "space";
  if (normalized === "+") return "plus";
  if (normalized.length === 1 || NAMED_KEYS.has(normalized)) return normalized;
  return null;
}

export function normalizeShortcutChord(chord: string): string | null {
  const parts = chord
    .trim()
    .toLocaleLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (
    MODIFIER_TOKENS.has(key) ||
    (key.length !== 1 && !NAMED_KEYS.has(key)) ||
    modifiers.some((modifier) => !MODIFIER_TOKENS.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return null;
  }
  const canonical = [
    ...(modifiers.includes("mod") ? ["mod"] : []),
    ...(modifiers.includes("shift") ? ["shift"] : []),
    ...(modifiers.includes("alt") ? ["alt"] : []),
    key,
  ];
  return canonical.join("+");
}

export function resolveCommandChord(
  command: AppCommand,
  overrides: ShortcutOverrides | undefined,
): string | undefined {
  const defaultChord = command.chord
    ? (normalizeShortcutChord(command.chord) ?? undefined)
    : undefined;
  if (!defaultChord || !hasOwn(overrides, command.id)) return defaultChord;
  const override = overrides![command.id];
  if (override === null) return undefined;
  return normalizeShortcutChord(override) ?? defaultChord;
}

export function resolveCommandBindings(
  commands: readonly AppCommand[],
  overrides: ShortcutOverrides | undefined,
): readonly AppCommand[] {
  return commands.map((command) => {
    const chord = resolveCommandChord(command, overrides);
    return chord === command.chord ? command : { ...command, chord };
  });
}

export function hasShortcutOverride(
  overrides: ShortcutOverrides | undefined,
  commandId: string,
): boolean {
  return hasOwn(overrides, commandId);
}

export function updateShortcutOverride(
  overrides: ShortcutOverrides | undefined,
  command: AppCommand,
  chord: string | null,
): ShortcutOverrides {
  const next = { ...overrides };
  if (chord === null) {
    next[command.id] = null;
    return next;
  }
  const normalized = normalizeShortcutChord(chord);
  if (!normalized) throw new Error(`Invalid shortcut chord: ${chord}`);
  if (normalized === normalizeShortcutChord(command.chord ?? "")) {
    delete next[command.id];
  } else {
    next[command.id] = normalized;
  }
  return next;
}

export function resetShortcutOverride(
  overrides: ShortcutOverrides | undefined,
  commandId: string,
): ShortcutOverrides {
  const next = { ...overrides };
  delete next[commandId];
  return next;
}

export function findShortcutConflict(
  commandId: string,
  chord: string,
  commands: readonly AppCommand[],
  overrides: ShortcutOverrides | undefined,
): AppCommand | null {
  const normalized = normalizeShortcutChord(chord);
  if (!normalized) return null;
  return (
    commands.find(
      (command) =>
        command.id !== commandId && resolveCommandChord(command, overrides) === normalized,
    ) ?? null
  );
}

export type ShortcutCaptureResult =
  | { kind: "passthrough" }
  | { kind: "waiting" }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "invalid"; reason: "modifier-required" | "unsupported" }
  | { kind: "chord"; chord: string };

export function captureShortcutChord(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "repeat"
  >,
  isMac: boolean,
): ShortcutCaptureResult {
  if (event.isComposing || event.repeat || event.key === "Tab") {
    return { kind: "passthrough" };
  }
  if (event.key === "Escape") return { kind: "cancel" };

  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondaryPrimary = isMac ? event.ctrlKey : event.metaKey;
  const normalizedKey = event.key.toLocaleLowerCase();
  if (MODIFIER_KEYS.has(normalizedKey)) return { kind: "waiting" };
  if (
    !primary &&
    !secondaryPrimary &&
    !event.shiftKey &&
    !event.altKey &&
    (event.key === "Backspace" || event.key === "Delete")
  ) {
    return { kind: "clear" };
  }
  if (secondaryPrimary) return { kind: "invalid", reason: "unsupported" };

  const key = keyToken(event.key);
  if (!key) return { kind: "invalid", reason: "unsupported" };
  const isFunctionKey = /^f(?:[1-9]|1[0-2])$/.test(key);
  if (!primary && !event.altKey && !isFunctionKey) {
    return { kind: "invalid", reason: "modifier-required" };
  }
  const chord = normalizeShortcutChord(
    [
      ...(primary ? ["mod"] : []),
      ...(event.shiftKey ? ["shift"] : []),
      ...(event.altKey ? ["alt"] : []),
      key,
    ].join("+"),
  );
  return chord ? { kind: "chord", chord } : { kind: "invalid", reason: "unsupported" };
}
