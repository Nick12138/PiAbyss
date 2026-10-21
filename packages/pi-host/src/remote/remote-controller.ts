/**
 * `remote.*` 协议处理器。
 *
 * 只做三件事：校验参数形状（协议层已做）、调用 `RemoteService`、把异常翻译成
 * 可读的 Host 错误。所有状态/凭据规则都在 service 里，控制器不碰文件系统。
 */
import { createHostError, type RemoteSettingsUpdate } from "@piabyss/protocol";
import type { MethodHandler } from "../server.js";
import type { RemoteService } from "./remote-service.js";

type Outcome = { result: unknown } | { error: ReturnType<typeof createHostError> };

async function attempt(run: () => Promise<unknown>, retryable = false): Promise<Outcome> {
  try {
    return { result: await run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: createHostError("INVALID_REQUEST", message, { retryable }),
    };
  }
}

export function createRemoteHandlers(
  service: RemoteService,
): Partial<Record<string, MethodHandler>> {
  const status = (): Promise<Outcome> => attempt(() => service.status());

  return {
    "remote.getStatus": () => status(),
    "remote.configure": (ctx) =>
      attempt(() => service.configure(ctx.params as RemoteSettingsUpdate)),
    "remote.install": () => attempt(() => service.install(), true),
    "remote.uninstall": () => attempt(() => service.uninstall()),
    "remote.setConnectorRunning": (ctx) =>
      attempt(() => service.setConnectorRunning((ctx.params as { running: boolean }).running)),
    "remote.pairStart": () => attempt(() => service.pairStart(), true),
    "remote.pairPoll": (ctx) =>
      attempt(() => service.pairPoll((ctx.params as { pairingId: string }).pairingId), true),
  };
}
