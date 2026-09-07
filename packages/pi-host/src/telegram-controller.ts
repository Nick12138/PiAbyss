import { createHostError, type TelegramValidateTokenResult } from "@piabyss/protocol";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MethodHandler } from "./server.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
/** Telegram bot tokens look like `<digits>:<base64-ish>`. */
const TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
/** Default Telegram workspace directory relative to the agent dir. */
const TELEGRAM_WORKSPACE_SEGMENT = "workspace/telegram";

type GetMeResponse = {
  ok: boolean;
  description?: string;
  result?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
};

/** Maps a getMe network/abort error to an actionable one-line description.
 *
 *  Telegram's api.telegram.org is frequently unreachable from networks that
 *  block it — the symptom is a TCP connect timeout, not an HTTP response. The
 *  host already installs an undici `EnvHttpProxyAgent` global dispatcher that
 *  honors the global settings `httpProxy` (mirrored to `HTTPS_PROXY`), so a
 *  connect failure here almost always means no proxy is configured. Surface
 *  that hint instead of a bare "Timed out contacting Telegram."
 */
function describeTelegramCallError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Our own AbortController fired (10 s hard timeout).
  if (err.name === "AbortError") {
    return (
      "Timed out contacting Telegram. If the Telegram API is not directly " +
      "reachable from your network, set `httpProxy` in the agent settings.json " +
      "to a reachable HTTP proxy and restart the host."
    );
  }
  // Undici connect / socket failures carry a `code`.
  const code = (err as { code?: string }).code;
  const isConnectFailure =
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT";
  if (isConnectFailure) {
    return (
      `Could not reach the Telegram API (${err.message}). If Telegram is blocked ` +
      "on your network, set `httpProxy` in the agent settings.json " +
      '(e.g. "http://127.0.0.1:7897") and restart the host.'
    );
  }
  return err.message;
}

/**
 * Host method `telegram.validateToken`.
 *
 * Calls Telegram's `getMe` with the provided bot token and returns the bot
 * identity (username / first name) on success, or a normalized failure with
 * Telegram's `description` on failure. No credential is persisted — the
 * frontend decides where to store the returned identity.
 *
 * Side effect: on success this also provisions the default Telegram workspace
 * directory at `<agentDir>/workspace/telegram` (created if missing) and returns
 * its absolute path as `workspacePath`.
 */
export function createTelegramHandlers(agentDir: string): Partial<Record<string, MethodHandler>> {
  /** Ensures `<agentDir>/workspace/telegram` exists and returns its absolute path. */
  const ensureTelegramWorkspace = async (): Promise<string> => {
    const workspacePath = join(agentDir, TELEGRAM_WORKSPACE_SEGMENT);
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  };
  return {
    "telegram.validateToken": async (ctx) => {
      const { token } = ctx.params as { token: string };
      const trimmed = token?.trim();
      if (!trimmed) {
        return { error: createHostError("INVALID_REQUEST", "Bot token is required") };
      }
      if (!TOKEN_PATTERN.test(trimmed)) {
        return {
          // Surface as a soft failure result rather than a hard host error so
          // the frontend can show "token looks invalid" without retrying.
          result: {
            ok: false,
            description: "Token does not match the expected Telegram bot token format.",
          } satisfies TelegramValidateTokenResult,
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${TELEGRAM_API_BASE}/bot${trimmed}/getMe`, {
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => undefined)) as GetMeResponse | undefined;
        if (!data) {
          return {
            result: {
              ok: false,
              description: "Telegram returned a non-JSON response.",
            } satisfies TelegramValidateTokenResult,
          };
        }
        if (!data.ok || !data.result) {
          return {
            result: {
              ok: false,
              description: data.description ?? "Telegram rejected the token.",
            } satisfies TelegramValidateTokenResult,
          };
        }
        const bot = data.result;
        if (bot.is_bot === false) {
          return {
            result: {
              ok: false,
              description: "Token belongs to a user account, not a bot.",
            } satisfies TelegramValidateTokenResult,
          };
        }
        // Provision the default Telegram workspace directory so a later
        // workspace.setCurrent can switch to it without ENOENT. A failed mkdir
        // is surfaced alongside the validated identity (ok stays true) so the
        // user keeps the token result and can retry the dir separately.
        let workspacePath: string | undefined;
        let provisionError: string | undefined;
        try {
          workspacePath = await ensureTelegramWorkspace();
        } catch (err) {
          provisionError = err instanceof Error ? err.message : String(err);
        }
        return {
          result: {
            ok: true,
            botId: bot.id,
            username: bot.username,
            firstName: bot.first_name,
            ...(workspacePath ? { workspacePath } : {}),
            ...(provisionError
              ? { description: `Token valid but failed to create workspace: ${provisionError}` }
              : {}),
          } satisfies TelegramValidateTokenResult,
        };
      } catch (err) {
        return {
          result: {
            ok: false,
            description: describeTelegramCallError(err),
          } satisfies TelegramValidateTokenResult,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
