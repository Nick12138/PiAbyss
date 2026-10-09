/**
 * Pending per-run model/thinking overrides picked in the subagent
 * conversation view.
 *
 * A selection never touches the run by itself: the chosen `provider/id` and
 * thinking level ride along with the NEXT `subagents.send` /
 * `subagents.resume` call and are applied when the plugin respawns the
 * child (terminal-state resume). Steer sends to a live process cannot
 * hot-swap either, so the override simply stays pending until a spawn
 * actually consumes it.
 *
 * Module-level (not app state): the map only needs to outlive component
 * remounts while switching between the main session and subagent views;
 * it is intentionally not persisted across app restarts.
 */
export type SubagentModelOverride = {
  /** provider/id string; unset means "keep whatever the run uses". */
  model?: string;
  /** Thinking level (off/minimal/low/medium/high/xhigh/max); unset means
   *  the plugin's own default for the model. */
  thinking?: string;
};

const pendingOverrides = new Map<string, SubagentModelOverride>();

export function getPendingSubagentOverride(
  nodeId: string | null,
): SubagentModelOverride | undefined {
  return nodeId ? pendingOverrides.get(nodeId) : undefined;
}

export function setPendingSubagentOverride(
  nodeId: string | null,
  override: SubagentModelOverride | undefined,
): void {
  if (!nodeId) return;
  if (override === undefined || (override.model === undefined && override.thinking === undefined)) {
    pendingOverrides.delete(nodeId);
  } else {
    pendingOverrides.set(nodeId, override);
  }
}
