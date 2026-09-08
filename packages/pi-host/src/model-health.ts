import type { ModelConfigHealth } from "@piabyss/protocol";
import type { JournalRecovery } from "./provider-journal.js";

const MIGRATION_HINT = {
  code: "SESSION_AFFINITY_FORMAT_REQUIRED" as const,
  message:
    'Use sessionAffinityFormat; the old sendSessionIdHeader:false maps to sessionAffinityFormat:"openai-nosession".',
};

/**
 * Build ModelConfigHealth from ModelRegistry.getError() output.
 * Never includes raw headers/tokens.
 */
export function buildModelConfigHealth(errorMessage: string | null | undefined): ModelConfigHealth {
  if (!errorMessage) {
    return {
      state: "ok",
      source: "ModelRegistry.getError",
    };
  }

  // Sanitize: strip anything that looks like a secret-bearing value
  const message = sanitizeModelError(errorMessage);
  const health: ModelConfigHealth = {
    state: "error",
    source: "ModelRegistry.getError",
    message,
  };

  if (/sendSessionIdHeader/i.test(errorMessage)) {
    health.migrationHint = MIGRATION_HINT;
  }

  return health;
}

/**
 * Health for an interrupted provider mutation that could not be rolled back.
 *
 * This outranks `ModelRegistry.getError`: the configuration may parse cleanly
 * and still be incoherent, because models.json and auth.json were written by
 * different halves of a failed transaction.
 */
export function buildDegradedModelConfigHealth(recovery: JournalRecovery): ModelConfigHealth {
  return {
    state: "degraded",
    source: "provider.journal",
    message: sanitizeModelError(recovery.message),
    recovery: {
      journalId: recovery.journalId,
      stage: recovery.stage,
      restored: recovery.restored,
    },
  };
}

function sanitizeModelError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._\-/+=]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 2000);
}
