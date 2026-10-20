import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingTranscriptScrollForTest,
  requestTranscriptScroll,
  requestTranscriptScrollWhenReady,
  subscribeTranscriptScroll,
} from "./transcript-navigation";

afterEach(() => {
  clearPendingTranscriptScrollForTest();
});

describe("transcript navigation", () => {
  it("delivers a jump request to a transcript that subscribes later", () => {
    expect(requestTranscriptScrollWhenReady({ sourceId: "entry-1" })).toBe(false);

    const handler = vi.fn(() => true);
    const unsubscribe = subscribeTranscriptScroll(handler);
    expect(handler).toHaveBeenCalledWith({ sourceId: "entry-1" });

    // Delivered once: a second subscription must not replay it.
    const later = vi.fn(() => true);
    const unsubscribeLater = subscribeTranscriptScroll(later);
    expect(later).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribeLater();
  });

  it("keeps the request pending until a handler accepts it", () => {
    const reject = vi.fn(() => false);
    const unsubscribeReject = subscribeTranscriptScroll(reject);

    expect(requestTranscriptScrollWhenReady({ sourceId: "entry-2" })).toBe(false);
    expect(reject).toHaveBeenCalledTimes(1);

    const accept = vi.fn(() => true);
    const unsubscribeAccept = subscribeTranscriptScroll(accept);
    expect(accept).toHaveBeenCalledWith({ sourceId: "entry-2" });

    expect(requestTranscriptScroll({ sourceId: "entry-2" })).toBe(true);
    expect(accept).toHaveBeenCalledTimes(2);

    unsubscribeReject();
    unsubscribeAccept();
  });
});
