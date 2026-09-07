import type { BusySendBehavior } from "@piabyss/protocol";

export function busySendMethod(
  behavior: BusySendBehavior | undefined,
): "agent.followUp" | "agent.steer" {
  return behavior === "steer" ? "agent.steer" : "agent.followUp";
}
