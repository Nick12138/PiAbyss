import { describe, expect, it } from "vitest";
import type { Translate } from "../i18n/use-t";
import {
  hostErrorLevel,
  isInformationalHostMessage,
  localizeHostError,
  localizePackageMessage,
  TRANSIENT_HOST_ERROR_CODES,
} from "./localize-host-error";

describe("localizeHostError", () => {
  const t: Translate = (key) =>
    key === "hostErrSessionNotInWorkspace"
      ? "会话不在当前工作区，请先切换工作区"
      : key === "hostErrAgentBusy"
        ? "Agent 正忙，请等待当前运行结束后再试。"
        : key === "hostErrSessionNotFound"
          ? "会话不存在。"
          : key === "hostErrStaleState"
            ? "界面状态已过期，该操作未生效，请重试。"
            : key === "hostErrStaleGit"
              ? "Git 状态已变化，该操作未生效，请刷新后重试。"
              : key === "hostErrCompactNothingToCompact"
                ? "本会话历史太短，暂无可压缩的内容。"
                : key === "hostErrCompactAlreadyCompacted"
                  ? "本会话刚刚压缩过，请继续对话后再压缩。"
                  : key === "hostErrUnknown"
                    ? "操作失败。"
                    : `[${key}]`;

  it("maps the not-in-workspace host message to a localized string", () => {
    expect(
      localizeHostError(
        {
          code: "SESSION_NOT_FOUND",
          message: "Session is not in the current workspace; switch workspace first",
        },
        t,
      ),
    ).toBe("会话不在当前工作区，请先切换工作区");
  });

  it("maps known error codes", () => {
    expect(localizeHostError({ code: "AGENT_BUSY", message: "Agent is busy" }, t)).toBe(
      "Agent 正忙，请等待当前运行结束后再试。",
    );
    expect(localizeHostError({ code: "SESSION_NOT_FOUND", message: "Session not found" }, t)).toBe(
      "会话不存在。",
    );
  });

  it("passes through unknown error messages", () => {
    expect(localizeHostError({ code: "INTERNAL_ERROR", message: "Some detail" }, t)).toBe(
      "Some detail",
    );
  });

  it("localizes STALE_REVISION identity races as a generic stale-state text", () => {
    expect(localizeHostError({ code: "STALE_REVISION", message: "Workspace id mismatch" }, t)).toBe(
      "界面状态已过期，该操作未生效，请重试。",
    );
    expect(
      localizeHostError({ code: "STALE_REVISION", message: "Host instance mismatch" }, t),
    ).toBe("界面状态已过期，该操作未生效，请重试。");
    expect(
      localizeHostError(
        { code: "STALE_REVISION", message: "Queue changed before the operation committed" },
        t,
      ),
    ).toBe("界面状态已过期，该操作未生效，请重试。");
  });

  it("localizes STALE_REVISION git races as a git-specific stale text", () => {
    expect(
      localizeHostError(
        { code: "STALE_REVISION", message: "The selected diff hunk no longer exists" },
        t,
      ),
    ).toBe("Git 状态已变化，该操作未生效，请刷新后重试。");
    expect(
      localizeHostError(
        { code: "STALE_REVISION", message: "Git status changed before the operation" },
        t,
      ),
    ).toBe("Git 状态已变化，该操作未生效，请刷新后重试。");
  });

  it("falls back when the error is missing", () => {
    expect(localizeHostError(undefined, t)).toBe("操作失败。");
  });

  it("maps a locked-file package failure (EBUSY) to a friendly message", () => {
    const stderr =
      "failed with code 4294963214: npm error code EBUSY\nnpm error syscall copyfile\nnpm error EBUSY: resource busy or locked, copyfile 'C:\\x.node'";
    expect(localizeHostError({ code: "PACKAGE_REMOVE_FAILED", message: stderr }, t)).toBe(
      "[hostErrPackageFileBusy]",
    );
    expect(localizeHostError({ code: "PACKAGE_PARTIAL_FAILURE", message: stderr }, t)).toBe(
      "[hostErrPackageFileBusy]",
    );
  });

  it("maps permission, missing-package and network failures to friendly messages", () => {
    expect(
      localizeHostError(
        {
          code: "PACKAGE_INSTALL_FAILED",
          message: "npm error code EPERM\nnpm error syscall mkdir",
        },
        t,
      ),
    ).toBe("[hostErrPackagePermission]");
    expect(
      localizeHostError(
        { code: "PACKAGE_INSTALL_FAILED", message: "npm error code E404\nnpm error 404 Not Found" },
        t,
      ),
    ).toBe("[hostErrPackageNotInRegistry]");
    expect(
      localizeHostError({ code: "PACKAGE_UPDATE_FAILED", message: "npm error code ETIMEDOUT" }, t),
    ).toBe("[hostErrPackageNetwork]");
  });

  it("falls back to a generic package message instead of dumping raw stderr", () => {
    expect(
      localizeHostError({ code: "PACKAGE_RESOLVE_FAILED", message: "some odd npm stderr dump" }, t),
    ).toBe("[hostErrPackageFailed]");
  });

  it("localizes the SDK's raw compaction refusals", () => {
    // The SDK throws plain English strings; the host wraps them as a bare
    // INTERNAL_ERROR, so only the message can identify them.
    expect(
      localizeHostError(
        { code: "INTERNAL_ERROR", message: "Nothing to compact (session too small)" },
        t,
      ),
    ).toBe("本会话历史太短，暂无可压缩的内容。");
    expect(localizeHostError({ code: "INTERNAL_ERROR", message: "Already compacted" }, t)).toBe(
      "本会话刚刚压缩过，请继续对话后再压缩。",
    );
  });

  it("localizePackageMessage detects known causes and returns undefined otherwise", () => {
    expect(localizePackageMessage("EBUSY: resource busy or locked", t)).toBe(
      "[hostErrPackageFileBusy]",
    );
    expect(localizePackageMessage("something completely different", t)).toBeUndefined();
    expect(localizePackageMessage(undefined, t)).toBeUndefined();
  });
});

describe("hostErrorLevel", () => {
  it("treats AGENT_BUSY as a transient (info) notification", () => {
    expect(hostErrorLevel({ code: "AGENT_BUSY", message: "Agent is busy" })).toBe("info");
  });

  it("treats PACKAGE_MUTATION_BUSY as a transient (info) notification", () => {
    expect(
      hostErrorLevel({ code: "PACKAGE_MUTATION_BUSY", message: "Another package operation" }),
    ).toBe("info");
  });

  it("keeps other host errors as persistent (error) notifications", () => {
    expect(hostErrorLevel({ code: "SESSION_NOT_FOUND", message: "Session not found" })).toBe(
      "error",
    );
    expect(hostErrorLevel({ code: "INTERNAL_ERROR", message: "Some detail" })).toBe("error");
  });

  it("treats STALE_REVISION as a transient (info) notification", () => {
    expect(hostErrorLevel({ code: "STALE_REVISION", message: "Workspace id mismatch" })).toBe(
      "info",
    );
    expect(TRANSIENT_HOST_ERROR_CODES.has("STALE_REVISION")).toBe(true);
  });

  it("falls back to error for missing errors", () => {
    expect(hostErrorLevel(undefined)).toBe("error");
    expect(hostErrorLevel(null)).toBe("error");
    expect(hostErrorLevel({})).toBe("error");
  });

  it("treats refused compaction as an info toast that never enters the history", () => {
    // Pressing "Compact now" on a short session is an expected no-op, not a
    // failure: it must toast without being retained by the bell history.
    expect(
      hostErrorLevel({ code: "INTERNAL_ERROR", message: "Nothing to compact (session too small)" }),
    ).toBe("info");
    expect(hostErrorLevel({ code: "INTERNAL_ERROR", message: "Already compacted" })).toBe("info");
    expect(isInformationalHostMessage({ message: "Nothing to compact (session too small)" })).toBe(
      true,
    );
  });

  it("keeps unrelated INTERNAL_ERROR messages persistent", () => {
    expect(hostErrorLevel({ code: "INTERNAL_ERROR", message: "Handler threw" })).toBe("error");
    expect(isInformationalHostMessage({ message: "Handler threw" })).toBe(false);
    expect(isInformationalHostMessage(undefined)).toBe(false);
  });

  it("exposes AGENT_BUSY as a transient host error code", () => {
    expect(TRANSIENT_HOST_ERROR_CODES.has("AGENT_BUSY")).toBe(true);
    expect(TRANSIENT_HOST_ERROR_CODES.has("SESSION_NOT_FOUND")).toBe(false);
  });

  it("exposes PACKAGE_MUTATION_BUSY as a transient host error code", () => {
    expect(TRANSIENT_HOST_ERROR_CODES.has("PACKAGE_MUTATION_BUSY")).toBe(true);
    expect(TRANSIENT_HOST_ERROR_CODES.has("INTERNAL_ERROR")).toBe(false);
  });
});
