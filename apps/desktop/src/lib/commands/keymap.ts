import type { AppCommand } from "./registry";
import { normalizeShortcutChord } from "./shortcut-bindings";

export type KeymapContext = {
  isMac: boolean;
  hasOverlay?: boolean;
};

function normalizedKey(event: KeyboardEvent): string {
  if (event.key === " ") return "space";
  if (event.key === "+") return "plus";
  return event.key.toLocaleLowerCase();
}

export function matchesCommandChord(event: KeyboardEvent, chord: string, isMac: boolean): boolean {
  const normalizedChord = normalizeShortcutChord(chord);
  if (!normalizedChord) return false;
  const parts = normalizedChord.split("+");
  const key = parts.at(-1);
  const needsMod = parts.includes("mod");
  const needsShift = parts.includes("shift");
  const needsAlt = parts.includes("alt");
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondaryPrimary = isMac ? event.ctrlKey : event.metaKey;
  return (
    normalizedKey(event) === key &&
    primary === needsMod &&
    secondaryPrimary === false &&
    event.shiftKey === needsShift &&
    event.altKey === needsAlt
  );
}

/**
 * 平台主修饰键（⌘ / Ctrl）**两者都认**的 mod 判定。
 *
 * `matchesCommandChord` 只认当前平台那一个（mac 上 Ctrl 无效、Windows 上 ⌘ 无效），
 * 适合全局 command 的精确分发；但文本框里的「保存」（Ctrl+S / ⌘S）是用户肌肉记忆，
 * WebView 里两个键都该存盘，所以在不硬编码 `isMac` 分支的前提下，用这条把两种
 * 平台假设各跑一遍：等于 `mod` 命中且另一个主修饰键没被同时按住（alt/shift 照旧排除）。
 */
export function matchesEitherPrimaryChord(event: KeyboardEvent, chord: string): boolean {
  return matchesCommandChord(event, chord, true) || matchesCommandChord(event, chord, false);
}

function closest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  return Boolean(
    closest(
      target,
      'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"]',
    ),
  );
}

export function findMatchingCommand(
  event: KeyboardEvent,
  commands: readonly AppCommand[],
  context: KeymapContext,
): AppCommand | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (closest(event.target, "[data-shortcut-recorder]")) return null;
  const command = commands.find(
    (candidate) => candidate.chord && matchesCommandChord(event, candidate.chord, context.isMac),
  );
  if (!command) return null;
  if (closest(event.target, ".xterm") && !command.worksInTerminal) return null;
  if (
    isTextInputTarget(event.target) &&
    !command.chord?.includes("mod+") &&
    !command.chord?.includes("alt+")
  ) {
    if (!command.textInputSelector || !closest(event.target, command.textInputSelector)) {
      return null;
    }
  }
  if (command.blockedByOverlay && context.hasOverlay) return null;
  return command;
}

export function formatCommandChord(chord: string, isMac: boolean): string {
  const normalized = normalizeShortcutChord(chord) ?? chord;
  const keyLabels: Record<string, string> = {
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    backspace: "Backspace",
    delete: "Delete",
    end: "End",
    enter: "Enter",
    escape: "Esc",
    home: "Home",
    pagedown: "Page Down",
    pageup: "Page Up",
    plus: "+",
    space: "Space",
    tab: "Tab",
  };
  const labels = normalized.split("+").map((part) => {
    if (part === "mod") return isMac ? "⌘" : "Ctrl";
    if (part === "shift") return isMac ? "⇧" : "Shift";
    if (part === "alt") return isMac ? "⌥" : "Alt";
    if (keyLabels[part]) return keyLabels[part];
    return part.length === 1 ? part.toLocaleUpperCase() : part;
  });
  return isMac ? labels.join("") : labels.join("+");
}
