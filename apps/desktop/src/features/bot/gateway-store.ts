/**
 * Frontend-only persistence for messaging bot gateways.
 *
 * This is a placeholder layer until the real backend wiring lands;
 * persistence is local to the renderer (localStorage). Replace with a
 * protocol-backed settings field / Host command later.
 */

type BotGatewayKind = "telegram" | "weixin";

export type BotGateway = {
  id: string;
  kind: BotGatewayKind;
  /** User-facing display name for the gateway row. */
  name: string;
  /** Telegram bot token (kept client-side only in this demo layer). */
  token: string;
  /** Optional bot handle, e.g. "@my_pi_bot". */
  handle: string;
  /** Telegram numeric bot user id (from getMe). */
  botId: number | null;
  /** Bot username returned by Telegram getMe (without leading @). */
  username: string | null;
  /** Bot display name returned by Telegram getMe (first_name). */
  firstName: string | null;
  /** Workspace path this gateway is bound to, or null for "follow active". */
  boundWorkspacePath: string | null;
  connected: boolean;
  /** Unix ms of creation. */
  createdAt: number;
};

const STORAGE_KEY = "piabyss.bot.gateways.v1";

export function loadBotGateways(): BotGateway[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as BotGateway[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (g) => g && (g.kind === "telegram" || g.kind === "weixin") && typeof g.token === "string",
    );
  } catch {
    return [];
  }
}

export function saveBotGateways(gateways: BotGateway[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(gateways));
  } catch {
    /* ignore unavailable localStorage */
  }
}

export function createTelegramGateway(input: {
  token: string;
  username: string | null;
  firstName: string | null;
  botId: number | null;
  name: string;
  boundWorkspacePath: string | null;
}): BotGateway {
  const trimmedToken = input.token.trim();
  const handle = input.username ? `@${input.username}` : "";
  const name = input.name.trim() || input.username || input.firstName || "Telegram Bot";
  return {
    id: `tg-${crypto.randomUUID()}`,
    kind: "telegram",
    name,
    token: trimmedToken,
    handle,
    botId: input.botId,
    username: input.username,
    firstName: input.firstName,
    boundWorkspacePath: input.boundWorkspacePath ?? null,
    connected: true,
    createdAt: Date.now(),
  };
}

export function addGateway(gateway: BotGateway): BotGateway[] {
  const next = [...loadBotGateways(), gateway];
  saveBotGateways(next);
  return next;
}

/** Removes the gateway with the given id and returns the new list. */
export function removeGateway(id: string): BotGateway[] {
  const next = loadBotGateways().filter((g) => g.id !== id);
  saveBotGateways(next);
  return next;
}
