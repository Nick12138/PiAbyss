import { describe, expect, it } from "vitest";
import { parseHostResponse, type HostIdentity } from "@piabyss/protocol";
import { OutboundWriter, type WritableLike } from "./outbound-queue.js";

const identity: HostIdentity = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 1,
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionRevision: 1,
  packageRevision: 1,
};

/** Fake stream: collects lines; can simulate a stalled pipe until drained. */
function fakeStream(options?: { stalled?: boolean }) {
  const lines: string[] = [];
  let stalled = options?.stalled ?? false;
  const drainListeners: Array<() => void> = [];
  const stream: WritableLike = {
    write(chunk: string) {
      lines.push(chunk);
      return !stalled;
    },
    once(_event, listener) {
      drainListeners.push(listener);
      return stream;
    },
  };
  return {
    stream,
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    unstall() {
      stalled = false;
      for (const listener of drainListeners.splice(0)) listener();
    },
  };
}

function writer(
  stream: WritableLike,
  options?: { softWatermark?: number; hardCap?: number; maxFrameBytes?: number },
) {
  let sequence = 0;
  const out = new OutboundWriter({
    stream,
    allocateSequence: () => {
      sequence += 1;
      return sequence;
    },
    ...options,
  });
  return { out, lastSequence: () => sequence };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OutboundWriter", () => {
  it("preserves order across responses and events, sequences assigned at write", async () => {
    const fake = fakeStream();
    const { out } = writer(fake.stream);

    out.enqueueEvent(identity, "extensionUi.notification", { message: "a", level: "info" });
    out.enqueueResponse({ ok: true, id: "r1" });
    out.enqueueEvent(identity, "extensionUi.notification", { message: "b", level: "info" });
    await out.drain();

    const parsed = fake.parsed();
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.sequence).toBe(1);
    expect(parsed[1]!.id).toBe("r1");
    expect(parsed[2]!.sequence).toBe(2);
  });

  it("seals pre-snapshot events and returns their exact sequence watermark", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "host.statusChanged", { phase: "agentBusy" });
    out.enqueueBarrierResponse((watermark) => ({ ok: true, id: "rehydrate", watermark }));
    // A same-key event after the barrier must not replace the pre-snapshot event in place.
    out.enqueueEvent(identity, "host.statusChanged", { phase: "ready" });

    fake.unstall();
    await out.drain();

    const parsed = fake.parsed();
    expect(parsed.map((message) => message.sequence ?? message.id)).toEqual([1, 2, "rehydrate", 3]);
    expect(parsed[2]!.watermark).toBe(2);
    expect((parsed[1]!.payload as { phase: string }).phase).toBe("agentBusy");
    expect((parsed[3]!.payload as { phase: string }).phase).toBe("ready");
  });

  it("waits for stream drain when the pipe stalls, then flushes in order", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream);

    out.enqueueEvent(identity, "extensionUi.notification", { message: "one", level: "info" });
    out.enqueueEvent(identity, "extensionUi.notification", { message: "two", level: "info" });
    await settle();
    // First write went out (stream accepted it but reported backpressure).
    expect(fake.lines).toHaveLength(1);

    fake.unstall();
    await out.drain();
    expect(fake.lines).toHaveLength(2);
    const parsed = fake.parsed();
    expect((parsed[1]!.payload as { message: string }).message).toBe("two");
  });

  it("merges customFrame data for the same panel above the soft watermark", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    // First frame is written immediately; the stall queues the rest.
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p1", data: "AAA" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p1", data: "BBB" });
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p2", data: "XXX" });
    out.enqueueEvent(identity, "extensionUi.customFrame", { requestId: "p1", data: "CCC" });

    fake.unstall();
    await out.drain();

    const frames = fake
      .parsed()
      .filter((message) => message.event === "extensionUi.customFrame")
      .map((message) => message.payload as { requestId: string; data: string });
    expect(frames).toEqual([
      { requestId: "p1", data: "AAA" },
      { requestId: "p1", data: "BBBCCC" },
      { requestId: "p2", data: "XXX" },
    ]);
    // No sequence gaps despite coalescing.
    const sequences = fake.parsed().map((message) => message.sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("keeps only the latest snapshot-style event per key under pressure", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.statusChanged", { key: "k", text: "first" });
    out.enqueueEvent(identity, "extensionUi.statusChanged", { key: "k", text: "second" });
    out.enqueueEvent(identity, "extensionUi.statusChanged", { key: "other", text: "kept" });

    fake.unstall();
    await out.drain();

    const statuses = fake
      .parsed()
      .filter((message) => message.event === "extensionUi.statusChanged")
      .map((message) => (message.payload as { text: string }).text);
    expect(statuses).toEqual(["second", "kept"]);
  });

  it("keeps only the latest message renderer snapshot per entry under pressure", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.messageRendered", {
      entryId: "entry-1",
      render: { version: 1, collapsed: ["running"], expanded: ["running"] },
    });
    out.enqueueEvent(identity, "extensionUi.messageRendered", {
      entryId: "entry-1",
      render: { version: 1, collapsed: ["done"], expanded: ["final report"] },
    });
    out.enqueueEvent(identity, "extensionUi.messageRendered", {
      entryId: "entry-2",
      render: null,
    });

    fake.unstall();
    await out.drain();

    const renders = fake
      .parsed()
      .filter((message) => message.event === "extensionUi.messageRendered")
      .map((message) => message.payload);
    expect(renders).toEqual([
      {
        entryId: "entry-1",
        render: { version: 1, collapsed: ["done"], expanded: ["final report"] },
      },
      { entryId: "entry-2", render: null },
    ]);
  });

  it("keeps widget attention between its snapshot and a later same-key update", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.widgetChanged", {
      key: "brainstorm",
      widget: ["command content"],
    });
    out.enqueueEvent(identity, "extensionUi.widgetAttentionRequested", {
      key: "brainstorm",
      runId: "run-1",
      invocation: "brainstorm",
    });
    out.enqueueEvent(identity, "extensionUi.widgetChanged", {
      key: "brainstorm",
      widget: null,
    });

    fake.unstall();
    await out.drain();

    const widgetEvents = fake
      .parsed()
      .filter((message) =>
        ["extensionUi.widgetChanged", "extensionUi.widgetAttentionRequested"].includes(
          String(message.event),
        ),
      )
      .map((message) => ({ event: message.event, payload: message.payload }));
    expect(widgetEvents).toEqual([
      {
        event: "extensionUi.widgetChanged",
        payload: { key: "brainstorm", widget: ["command content"] },
      },
      {
        event: "extensionUi.widgetAttentionRequested",
        payload: { key: "brainstorm", runId: "run-1", invocation: "brainstorm" },
      },
      {
        event: "extensionUi.widgetChanged",
        payload: { key: "brainstorm", widget: null },
      },
    ]);
  });

  it("does not coalesce same-key widgets from different sessions", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });
    const backgroundIdentity: HostIdentity = {
      ...identity,
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionRevision: 2,
    };

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "extensionUi.widgetChanged", {
      key: "shared",
      widget: ["active session"],
    });
    out.enqueueEvent(backgroundIdentity, "extensionUi.widgetChanged", {
      key: "shared",
      widget: ["background session"],
    });

    fake.unstall();
    await out.drain();

    const widgets = fake
      .parsed()
      .filter((message) => message.event === "extensionUi.widgetChanged");
    expect(widgets).toHaveLength(2);
    expect(widgets.map((message) => message.sessionId)).toEqual([
      identity.sessionId,
      backgroundIdentity.sessionId,
    ]);
  });

  it("never drops responses and forces a sequence gap in catastrophe", async () => {
    const fake = fakeStream({ stalled: true });
    const { out, lastSequence } = writer(fake.stream, { softWatermark: 1, hardCap: 200 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    // Droppable bulk that blows past the cap.
    out.enqueueEvent(identity, "extensionUi.customFrame", {
      requestId: "p1",
      data: "x".repeat(400),
    });
    // A response and a critical-ish notification queued after.
    out.enqueueResponse({ ok: true, id: "keep-me" });
    out.enqueueEvent(identity, "extensionUi.notification", {
      message: "y".repeat(400),
      level: "info",
    });

    fake.unstall();
    await out.drain();

    const parsed = fake.parsed();
    // The oversized frame was shed; the response survived.
    expect(parsed.some((message) => message.id === "keep-me")).toBe(true);
    expect(parsed.some((message) => message.event === "extensionUi.customFrame")).toBe(false);
    // A sequence number was burned to force client-side gap recovery.
    const written = parsed.filter((message) => typeof message.sequence === "number").length;
    expect(lastSequence()).toBeGreaterThan(written);
  });

  it("sheds widget attention with its widget snapshot at the hard cap", async () => {
    const fake = fakeStream({ stalled: true });
    const { out, lastSequence } = writer(fake.stream, { softWatermark: 1, hardCap: 300 });

    out.enqueueEvent(identity, "extensionUi.notification", {
      message: "hold",
      level: "info",
    });
    await settle();
    out.enqueueEvent(identity, "extensionUi.widgetChanged", {
      key: "brainstorm",
      widget: ["new content"],
    });
    out.enqueueEvent(identity, "extensionUi.widgetAttentionRequested", {
      key: "brainstorm",
      runId: "run-1",
      invocation: "/brainstorm",
    });
    out.enqueueEvent(identity, "extensionUi.customFrame", {
      requestId: "oversized",
      data: "x".repeat(400),
    });

    fake.unstall();
    await out.drain();

    const events = fake.parsed().map((message) => message.event);
    expect(events).not.toContain("extensionUi.widgetChanged");
    expect(events).not.toContain("extensionUi.widgetAttentionRequested");
    const written = fake.parsed().filter((message) => typeof message.sequence === "number").length;
    expect(lastSequence()).toBeGreaterThan(written);
  });

  it("does not enqueue attention after its widget snapshot is shed on arrival", async () => {
    const fake = fakeStream({ stalled: true });
    const { out, lastSequence } = writer(fake.stream, { softWatermark: 1, hardCap: 200 });

    out.enqueueEvent(identity, "extensionUi.notification", {
      message: "hold",
      level: "info",
    });
    await settle();
    out.enqueueEvent(identity, "extensionUi.widgetChanged", {
      key: "brainstorm",
      widget: ["x".repeat(400)],
    });
    out.enqueueEvent(identity, "extensionUi.widgetAttentionRequested", {
      key: "brainstorm",
      runId: "run-1",
      invocation: "/brainstorm",
    });

    fake.unstall();
    await out.drain();

    const events = fake.parsed().map((message) => message.event);
    expect(events).not.toContain("extensionUi.widgetChanged");
    expect(events).not.toContain("extensionUi.widgetAttentionRequested");
    const written = fake.parsed().filter((message) => typeof message.sequence === "number").length;
    expect(lastSequence()).toBeGreaterThan(written);
  });

  it("forces recovery when first-pass shedding drops final authoritative state", async () => {
    const fake = fakeStream({ stalled: true });
    const { out, lastSequence } = writer(fake.stream, { softWatermark: 1, hardCap: 200 });

    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "session.runtimeChanged", {
      sessionId: identity.sessionId,
      sessionRevision: identity.sessionRevision,
      state: "error",
      updatedAt: 1,
      error: "x".repeat(300),
    });

    fake.unstall();
    await out.drain();

    expect(fake.parsed().some((message) => message.event === "session.runtimeChanged")).toBe(false);
    const written = fake.parsed().filter((message) => typeof message.sequence === "number").length;
    expect(lastSequence()).toBeGreaterThan(written);
  });

  it("keeps runtime transition edges ordered above the soft watermark", async () => {
    const fake = fakeStream({ stalled: true });
    const { out } = writer(fake.stream, { softWatermark: 1 });

    // Hold the pump so both runtime transitions are queued under pressure.
    out.enqueueEvent(identity, "extensionUi.notification", { message: "hold", level: "info" });
    await settle();
    out.enqueueEvent(identity, "session.runtimeChanged", {
      sessionId: identity.sessionId,
      sessionRevision: identity.sessionRevision,
      state: "running",
      updatedAt: 1,
    });
    out.enqueueEvent(identity, "session.runtimeChanged", {
      sessionId: identity.sessionId,
      sessionRevision: identity.sessionRevision,
      state: "idle",
      updatedAt: 2,
    });

    fake.unstall();
    await out.drain();

    expect(
      fake
        .parsed()
        .filter((message) => message.event === "session.runtimeChanged")
        .map((message) => (message.payload as { state: string }).state),
    ).toEqual(["running", "idle"]);
  });

  it("replaces an oversized response with a bounded correlated failure", async () => {
    const fake = fakeStream();
    const { out } = writer(fake.stream, { maxFrameBytes: 1024 });

    out.enqueueResponse({
      protocolVersion: 1,
      ...identity,
      id: "44444444-4444-4444-8444-444444444444",
      method: "session.getSnapshot",
      ok: true,
      result: { snapshot: "x".repeat(2_000) },
    });
    await out.drain();

    expect(fake.lines).toHaveLength(1);
    expect(Buffer.byteLength(fake.lines[0]!, "utf8")).toBeLessThanOrEqual(1024);
    expect(fake.parsed()[0]).toMatchObject({
      hostInstanceId: identity.hostInstanceId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      id: "44444444-4444-4444-8444-444444444444",
      method: "session.getSnapshot",
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(parseHostResponse(fake.parsed()[0])).toMatchObject({ ok: true });
  });

  it("uses UTF-8 bytes rather than JavaScript string length for the frame limit", async () => {
    const fake = fakeStream();
    const { out } = writer(fake.stream, { maxFrameBytes: 1024 });
    const body = {
      protocolVersion: 1,
      ...identity,
      id: "44444444-4444-4444-8444-444444444444",
      method: "session.getSnapshot",
      ok: true,
      result: { snapshot: "界".repeat(300) },
    };
    const originalLine = `${JSON.stringify(body)}\n`;
    expect(originalLine.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(originalLine, "utf8")).toBeGreaterThan(1024);

    out.enqueueResponse(body);
    await out.drain();

    expect(fake.parsed()[0]).toMatchObject({
      id: body.id,
      method: body.method,
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(Buffer.byteLength(fake.lines[0]!, "utf8")).toBeLessThanOrEqual(1024);
  });

  it("downgrades an oversized agent.event instead of dropping the turn boundary", async () => {
    const fake = fakeStream();
    const { out, lastSequence } = writer(fake.stream, { maxFrameBytes: 700 * 1024 });

    out.enqueueEvent(identity, "agent.event", {
      runId: "run-big",
      event: {
        type: "message_end",
        message: {
          role: "user",
          content: [
            { type: "text", text: "x".repeat(600 * 1024) },
            { type: "image", mimeType: "image/png", data: "y".repeat(600 * 1024) },
          ],
        },
      },
    });
    out.enqueueEvent(identity, "agent.event", {
      runId: "run-big",
      event: { type: "agent_start" },
    });
    await out.drain();

    const frames = fake.parsed();
    expect(frames).toHaveLength(2);
    // Turn structure survived the transport limit instead of forcing recovery.
    expect(frames[0]).toMatchObject({ event: "agent.event", sequence: 1 });
    const payload = frames[0] as unknown as {
      payload: { event: { message: { content: Array<Record<string, unknown>> } } };
    };
    expect(payload.payload.event.message.content[1]).toEqual({
      type: "text",
      text: "[image omitted: event payload exceeded transport limit]",
    });
    const firstPart = payload.payload.event.message.content[0]!;
    expect(String(firstPart.text)).toContain("[truncated: event payload exceeded transport limit]");
    // No sequence was burned by the downgrade path.
    expect(lastSequence()).toBe(2);
  });

  it("drops an oversized event after consuming its sequence", async () => {
    const fake = fakeStream();
    const { out, lastSequence } = writer(fake.stream, { maxFrameBytes: 1024 });

    out.enqueueEvent(identity, "extensionUi.notification", {
      message: "x".repeat(2_000),
      level: "info",
    });
    out.enqueueEvent(identity, "extensionUi.notification", {
      message: "kept",
      level: "info",
    });
    await out.drain();

    expect(fake.parsed()).toHaveLength(1);
    expect(fake.parsed()[0]).toMatchObject({
      event: "extensionUi.notification",
      sequence: 2,
      payload: { message: "kept" },
    });
    expect(lastSequence()).toBe(2);
  });

  it("does not burn a sequence when only a retained response exceeds the queue cap", async () => {
    const fake = fakeStream();
    const { out, lastSequence } = writer(fake.stream, { hardCap: 200 });

    out.enqueueResponse({
      protocolVersion: 1,
      ...identity,
      id: "44444444-4444-4444-8444-444444444444",
      method: "session.getSnapshot",
      ok: true,
      result: { snapshot: "x".repeat(400) },
    });
    await out.drain();

    expect(fake.lines).toHaveLength(1);
    expect(lastSequence()).toBe(0);
  });

  it("drain resolves immediately when idle", async () => {
    const fake = fakeStream();
    const { out } = writer(fake.stream);
    await out.drain();
    expect(fake.lines).toHaveLength(0);
  });
});
