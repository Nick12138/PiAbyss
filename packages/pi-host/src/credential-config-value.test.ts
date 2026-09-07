import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  clearCredentialCommandCache,
  isCommandConfigValue,
  resolveCredentialConfigValue,
} from "./credential-config-value.js";

const ENV_KEYS = ["PIABYSS_CV_A", "PIABYSS_CV_B", "PIABYSS_CV_CMD"];

beforeEach(() => {
  clearCredentialCommandCache();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  clearCredentialCommandCache();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("literal values", () => {
  it("passes an ordinary key through unchanged", () => {
    expect(resolveCredentialConfigValue("sk-ant-literal-value")).toBe("sk-ant-literal-value");
  });

  it("treats a lone dollar and an unparseable brace as literal text", () => {
    expect(resolveCredentialConfigValue("cost$")).toBe("cost$");
    expect(resolveCredentialConfigValue("${not a name}")).toBe("${not a name}");
    expect(resolveCredentialConfigValue("${unterminated")).toBe("${unterminated");
  });

  it("applies $$ and $! escapes", () => {
    expect(resolveCredentialConfigValue("a$$b")).toBe("a$b");
    expect(resolveCredentialConfigValue("$!not-a-command")).toBe("!not-a-command");
  });
});

describe("environment templates", () => {
  it("substitutes $NAME and ${NAME} from the process environment", () => {
    process.env.PIABYSS_CV_A = "alpha";
    expect(resolveCredentialConfigValue("$PIABYSS_CV_A")).toBe("alpha");
    expect(resolveCredentialConfigValue("${PIABYSS_CV_A}")).toBe("alpha");
  });

  it("prefers the credential env over the process environment", () => {
    process.env.PIABYSS_CV_A = "from-process";
    expect(resolveCredentialConfigValue("$PIABYSS_CV_A", { PIABYSS_CV_A: "from-credential" })).toBe(
      "from-credential",
    );
  });

  it("concatenates literals and multiple variables", () => {
    process.env.PIABYSS_CV_A = "one";
    process.env.PIABYSS_CV_B = "two";
    expect(resolveCredentialConfigValue("p-${PIABYSS_CV_A}-${PIABYSS_CV_B}-s")).toBe("p-one-two-s");
  });

  it("resolves to undefined when any referenced variable is unset", () => {
    process.env.PIABYSS_CV_A = "one";
    expect(resolveCredentialConfigValue("$PIABYSS_CV_MISSING")).toBeUndefined();
    expect(resolveCredentialConfigValue("${PIABYSS_CV_A}-${PIABYSS_CV_MISSING}")).toBeUndefined();
  });

  it("treats an empty variable as unset, matching the SDK", () => {
    process.env.PIABYSS_CV_A = "";
    expect(resolveCredentialConfigValue("$PIABYSS_CV_A")).toBeUndefined();
  });
});

describe("command values", () => {
  it("classifies a leading bang as a command", () => {
    expect(isCommandConfigValue("!echo hi")).toBe(true);
    expect(isCommandConfigValue("$PIABYSS_CV_A")).toBe(false);
    expect(isCommandConfigValue("$!echo hi")).toBe(false);
  });

  it("uses the trimmed stdout of the command", () => {
    expect(resolveCredentialConfigValue("!echo piabyss-secret")).toBe("piabyss-secret");
  });

  it("resolves to undefined when the command fails", () => {
    expect(resolveCredentialConfigValue("!piabyss-no-such-command-xyz")).toBeUndefined();
  });

  it("caches the result for the process lifetime and clears on request", () => {
    if (process.platform === "win32") return; // `$VAR` expansion is shell-specific.
    process.env.PIABYSS_CV_CMD = "first";
    const config = '!printf "%s" "$PIABYSS_CV_CMD"';

    expect(resolveCredentialConfigValue(config)).toBe("first");

    process.env.PIABYSS_CV_CMD = "second";
    expect(resolveCredentialConfigValue(config)).toBe("first");

    clearCredentialCommandCache();
    expect(resolveCredentialConfigValue(config)).toBe("second");
  });

  it("caches a failed command as undefined instead of re-running it", () => {
    if (process.platform === "win32") return;
    const marker = `/tmp/piabyss-cv-${process.pid}-${Date.now()}`;
    // Fails every time, but appends a line so we can count invocations.
    const config = `!sh -c 'echo x >> ${marker}; exit 3'`;

    expect(resolveCredentialConfigValue(config)).toBeUndefined();
    expect(resolveCredentialConfigValue(config)).toBeUndefined();

    const lines = existsSync(marker)
      ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length
      : 0;
    rmSync(marker, { force: true });
    expect(lines).toBe(1);
  });
});
