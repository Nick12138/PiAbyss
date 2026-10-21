import { describe, expect, it } from "vitest";
import {
  dedupeRequestIds,
  describeErrorMessage,
  errorHeadline,
  friendlyErrorHint,
  withFriendlyErrorHint,
} from "./error-hints";

describe("friendlyErrorHint", () => {
  it("flags 402 as channel out of balance", () => {
    expect(friendlyErrorHint("402 status code (no body)")).toContain("欠费");
  });

  it("flags 504 gateway pages as upstream overload", () => {
    const raw =
      '504 <html>\n<head><title>504 Gateway Time-out</title></head>\n<body bgcolor="white">\n<center><h1>504 Gateway Time-out</h1></center>\n<hr><center>alb</center>\n</body>\n</html>';
    expect(friendlyErrorHint(raw)).toContain("网关故障");
  });

  it("flags 429 as rate limit / quota exhaustion", () => {
    expect(friendlyErrorHint("429 status code (no body)")).toContain("限流");
  });

  it("flags 401/403 as auth failures", () => {
    expect(friendlyErrorHint("401 status code (no body)")).toContain("鉴权");
    expect(friendlyErrorHint("403 Forbidden")).toContain("鉴权");
  });

  it("flags bare 'terminated' as a cut stream", () => {
    expect(friendlyErrorHint("terminated")).toContain("掐断");
  });

  it("flags connection failures", () => {
    expect(friendlyErrorHint("Connection error.")).toContain("连不上");
    expect(friendlyErrorHint("fetch failed: connect ETIMEDOUT 1.2.3.4:443")).toContain("连不上");
  });

  it("flags streams ending without finish_reason", () => {
    expect(friendlyErrorHint("Stream ended without finish_reason")).toContain("未正常结束");
  });

  it("flags provider 'temporarily unavailable' messages", () => {
    const raw =
      "Service temporarily unavailable. Please try again later. (request id: 202609101319158213858053pa9MdSo) (request id: 202609101319158213858053pa9MdSo)";
    const hint = friendlyErrorHint(raw);
    expect(hint).toContain("服务商暂时不可用");
  });

  it("leaves user-initiated aborts alone", () => {
    expect(friendlyErrorHint("Request was aborted")).toBeUndefined();
  });

  it("leaves unrecognized errors alone", () => {
    expect(friendlyErrorHint("some weird provider bug")).toBeUndefined();
    expect(friendlyErrorHint(null)).toBeUndefined();
    expect(friendlyErrorHint("")).toBeUndefined();
  });

  it("does not match a status code embedded in an id-like token", () => {
    expect(friendlyErrorHint("job 14029 failed on shard 7")).toBeUndefined();
  });

  it("prefers the status hint over a message hint", () => {
    const hint = friendlyErrorHint("504 connection error from upstream");
    expect(hint).toContain("网关故障");
    expect(hint).not.toContain("连不上");
  });
});

describe("withFriendlyErrorHint", () => {
  it("preserves the raw text and appends the hint after a blank line", () => {
    const out = withFriendlyErrorHint("402 status code (no body)");
    expect(out.startsWith("402 status code (no body)\n\n")).toBe(true);
    expect(out).toContain("欠费");
  });

  it("returns unrecognized errors unchanged", () => {
    expect(withFriendlyErrorHint("unknown")).toBe("unknown");
  });

  it("collapses duplicated identical request ids", () => {
    const raw =
      "Service temporarily unavailable. Please try again later. (request id: abc123) (request id: abc123)";
    expect(withFriendlyErrorHint(raw)).toBe(
      "Service temporarily unavailable. Please try again later. (request id: abc123)\n\n💡 服务商暂时不可用（过载/维护）。",
    );
  });

  it("keeps distinct request ids", () => {
    const raw = "boom (request id: aaa) (request id: bbb)";
    expect(withFriendlyErrorHint(raw)).toBe("boom (request id: aaa) (request id: bbb)");
  });

  it("dedupeRequestIds collapses runs of identical ids", () => {
    expect(dedupeRequestIds("x (request id: a) (request id: a) (request id: a)")).toBe(
      "x (request id: a)",
    );
  });
});

describe("errorHeadline", () => {
  it("takes the meaning out of a gateway HTML page", () => {
    const raw =
      "504 <html>\n<head><title>504 Gateway Time-out</title></head>\n<body>\n<center><h1>504 Gateway Time-out</h1></center>\n<hr><center>awselb/2.0</center>\n</body>\n</html>";
    expect(errorHeadline(raw)).toBe("504 Gateway Time-out");
  });

  it("prefers a JSON error message over the braces", () => {
    expect(errorHeadline('{"error":{"message":"Context length exceeded"}}')).toBe(
      "Context length exceeded",
    );
  });

  it("flattens multi-line plain text onto one line", () => {
    expect(errorHeadline("line one\nline two\n\nline three")).toBe("line one line two line three");
  });

  it("clamps a long single-line payload", () => {
    const headline = errorHeadline(`boom ${"x".repeat(400)}`);
    expect(headline.length).toBeLessThanOrEqual(151);
    expect(headline.endsWith("…")).toBe(true);
  });
});

describe("describeErrorMessage", () => {
  it("returns hint + headline and keeps raw only when it adds detail", () => {
    const raw =
      "504 <html>\n<head><title>504 Gateway Time-out</title></head>\n<body><center>alb</center></body>\n</html>";
    const parts = describeErrorMessage(raw);
    expect(parts.headline).toBe("504 Gateway Time-out");
    expect(parts.hint).toContain("网关故障");
    // The hint's 💡 marker is dropped: the row paints its own severity icon.
    expect(parts.hint?.startsWith("💡")).toBe(false);
    expect(parts.raw).toContain("<html>");
  });

  it("drops raw when the headline already says everything", () => {
    const parts = describeErrorMessage("402 status code (no body)");
    expect(parts).toEqual({
      hint: "该渠道余额不足/已欠费（HTTP 402），重试无效。",
      headline: "402 status code (no body)",
    });
  });

  it("returns an empty object for missing text", () => {
    expect(describeErrorMessage(null)).toEqual({});
    expect(describeErrorMessage("   ")).toEqual({});
  });

  it("collapses duplicated request ids in the payload it hands to the drawer", () => {
    const parts = describeErrorMessage(
      "Error page <html><head><title>504 Gateway Time-out</title></head></html> (request id: abc) (request id: abc)",
    );
    expect(parts.raw).toBe(
      "Error page <html><head><title>504 Gateway Time-out</title></head></html> (request id: abc)",
    );
    expect(parts.headline).toBe("504 Gateway Time-out");
  });
});
