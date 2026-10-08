/** Shared presentation helpers for subagent runs (status nodes and persisted
 * transcripts). Extracted from the former dock SubagentsPanel so the top-bar
 * title entry and the full-page subagent conversation share one vocabulary. */
import type { SubagentStatusNode } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";

export function flattenNodes(
  nodes: SubagentStatusNode[],
  depth = 0,
): Array<{ node: SubagentStatusNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.children ? flattenNodes(node.children, depth + 1) : []),
  ]);
}

export function subagentStateLabel(
  state: SubagentStatusNode["state"],
  t: ReturnType<typeof useT>,
): string {
  switch (state) {
    case "running":
      return t("subagentsStateRunning");
    case "queued":
      return t("subagentsStateQueued");
    case "complete":
      return t("subagentsStateComplete");
    case "failed":
      return t("subagentsStateFailed");
    case "paused":
      return t("subagentsStatePaused");
    case "stopped":
      return t("subagentsStateStopped");
    default:
      return t("subagentsStateRejected");
  }
}

export function subagentStateClass(state: SubagentStatusNode["state"]): string {
  if (state === "running") return "text-accent";
  if (state === "complete") return "text-success";
  if (state === "failed" || state === "rejected") return "text-danger";
  if (state === "paused" || state === "stopped") return "text-warning";
  return "text-muted";
}

export function subagentRoleLabel(
  role: string | undefined,
  t: ReturnType<typeof useT>,
): string | undefined {
  switch (role?.trim().toLowerCase()) {
    case "scout":
      return t("subagentsRoleScout");
    case "researcher":
      return t("subagentsRoleResearcher");
    case "worker":
      return t("subagentsRoleWorker");
    case "reviewer":
      return t("subagentsRoleReviewer");
    case "delegate":
      return t("subagentsRoleDelegate");
    case "oracle":
    case "advisor":
      return t("subagentsRoleAdvisor");
    default:
      return role?.trim() || undefined;
  }
}

/** Badge glyphs: emoji for the built-in roles, undefined (fall back to the
 * localized text label) for anything else. */
export function subagentRoleEmoji(role: string | undefined): string | undefined {
  switch (role?.trim().toLowerCase()) {
    case "scout":
    case "researcher":
      return "🕵️";
    case "worker":
      return "🧑‍💻";
    case "reviewer":
      return "👀";
    default:
      return undefined;
  }
}
