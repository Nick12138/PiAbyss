import { describe, expect, it } from "vitest";
import { summarizeHostFailure } from "./host-failure-message.js";

describe("summarizeHostFailure", () => {
  it("uses the final structured stderr error without exposing its stack", () => {
    const message = [
      "Pi Host exited (exit status: 1). stderr: " +
        JSON.stringify({ level: "info", message: "Pi Host ready" }),
      JSON.stringify({
        level: "error",
        message: "Uncaught exception in Pi Host",
        meta: {
          error:
            "This extension ctx is stale after session replacement or reload. Do not reuse it.",
          stack: "very long stack",
        },
      }),
    ].join(" | ");

    expect(summarizeHostFailure(message)).toBe(
      "Pi Host exited (exit status: 1): This extension ctx is stale after session replacement or reload.",
    );
  });

  it("bounds unstructured native failures", () => {
    const summary = summarizeHostFailure(`unexpected ${"x".repeat(400)}`, 80);
    expect(summary).toHaveLength(80);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("prefers a native crash marker over older structured warn/debug records", () => {
    const message =
      "Pi Host process exited. stderr: " +
      [
        JSON.stringify({
          ts: "2026-09-10T08:21:40.828Z",
          level: "debug",
          message: "Prompt cache fingerprint baseline",
        }),
        JSON.stringify({ level: "warn", message: "Prompt cache prefix drift" }),
        "FATAL ERROR: Reached heap limit — Allocation failed — JavaScript heap out of memory",
      ].join(" | ");

    const summary = summarizeHostFailure(message);
    expect(summary).toContain("FATAL ERROR");
    expect(summary).not.toContain("Prompt cache");
  });

  it("falls back to the newest stderr line, never the stale head of the ring", () => {
    const message =
      "Pi Host process exited. stderr: " +
      [
        JSON.stringify({
          ts: "2026-09-10T08:21:40.828Z",
          level: "debug",
          message: "Stale baseline from a run 37 minutes ago",
        }),
        JSON.stringify({
          ts: "2026-09-10T08:58:10.000Z",
          level: "debug",
          message: "Newest line right before the crash",
        }),
      ].join(" | ");

    const summary = summarizeHostFailure(message);
    expect(summary).toContain("Newest line right before the crash");
    expect(summary).not.toContain("Stale baseline");
  });

  it("reports the exit code even when auto-restart wraps the failure", () => {
    const message =
      "Auto-restart failed: Pi Host exited (exit code: 1). stderr: " +
      JSON.stringify({ level: "error", message: "Uncaught exception in Pi Host" });

    const summary = summarizeHostFailure(message);
    expect(summary).toContain("Pi Host exited (exit code: 1)");
    expect(summary).toContain("Uncaught exception in Pi Host");
  });
});
