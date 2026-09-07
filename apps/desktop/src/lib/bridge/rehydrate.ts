/** Atomic Host snapshot and recovery-period event buffering (R2/R7). */
import type { HostEventEnvelope, RehydrateSnapshot } from "@piabyss/protocol";
import { hostClient } from "./host-client";

export type RehydrateResult = RehydrateSnapshot;

const DEFAULT_RECOVERY_EVENT_LIMIT = 10_000;

export class RecoveryEventBuffer {
  private hostInstanceId: string | null = null;
  private events: HostEventEnvelope[] = [];
  private overflowed = false;

  constructor(private readonly limit = DEFAULT_RECOVERY_EVENT_LIMIT) {}

  begin(hostInstanceId: string): void {
    this.hostInstanceId = hostInstanceId;
    this.events = [];
    this.overflowed = false;
  }

  capture(event: HostEventEnvelope): boolean {
    if (
      this.hostInstanceId === null ||
      event.hostInstanceId !== this.hostInstanceId ||
      event.event === "host.ready" ||
      event.event === "host.fatal"
    ) {
      return false;
    }
    if (this.events.length < this.limit) {
      this.events.push(event);
    } else {
      this.overflowed = true;
    }
    return true;
  }

  finish(
    hostInstanceId: string,
    watermark: number,
  ): { events: HostEventEnvelope[]; overflowed: boolean } {
    const sameHost = this.hostInstanceId === hostInstanceId;
    const events = sameHost ? this.events.filter((event) => event.sequence > watermark) : [];
    const overflowed = !sameHost || this.overflowed;
    this.cancel();
    return { events, overflowed };
  }

  cancel(): void {
    this.hostInstanceId = null;
    this.events = [];
    this.overflowed = false;
  }
}

export function resolveRehydrateHostInstanceId(
  expectedHostInstanceId: string | undefined,
  observedHostInstanceId: string | null,
): string | null {
  return expectedHostInstanceId ?? observedHostInstanceId;
}

export async function fullRehydrate(expectedHostInstanceId?: string): Promise<RehydrateResult> {
  const hostId = resolveRehydrateHostInstanceId(
    expectedHostInstanceId,
    hostClient.getHostInstanceId(),
  );
  if (!hostId) {
    throw new Error("No hostInstanceId — call hello first");
  }

  const response = await hostClient.request(
    "system.rehydrate",
    { expectedHostInstanceId: hostId },
    null,
    15_000,
  );
  if (!response.ok) {
    throw new Error(response.error?.message ?? "system.rehydrate failed");
  }
  return response.result;
}
