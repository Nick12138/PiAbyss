import { describe, expect, it } from "vitest";
import { friendlyErrorHint, withFriendlyErrorHint } from "./error-hints";

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
});
