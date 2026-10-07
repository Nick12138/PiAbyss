/**
 * Pixie delegation arm — the Host-side hooks the delegation engine needs.
 *
 * The `pixie_dispatch` / `pixie_report` tool shells now live in the my-pi-plugins
 * `pi-pixie` package (loaded as a normal extension; the resident session's copy
 * is wired up in `buildPixieSession`). What stays Host-owned here is the arm:
 * `armPixieDispatch` registers a delegation record and flips the report-gating
 * side of the engine. The plugin reaches the engine itself through the loopback
 * control plane (`pixie-control-plane.ts`), never through this module.
 */
import { logger } from "./logger.js";
import { registerDispatch } from "./pixie-agent-runner.js";

export { failDispatch } from "./pixie-agent-runner.js";

/** Convenience wrapper the control plane calls when a delegated prompt is
 *  injected: registers the dispatch and flips the report tool on. */
export function armPixieDispatch(input: {
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  task: string;
}): string {
  const record = registerDispatch(input);
  logger.info("pixie dispatch armed", { dispatchId: record.id, sessionId: input.sessionId });
  return record.id;
}
