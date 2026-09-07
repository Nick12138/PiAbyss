import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_BASH_ENV,
  BUNDLED_GIT_ENV,
  BUNDLED_NODE_ENV,
  bundledBashExecutable,
  bundledGitExecutable,
  bundledNodeExecutable,
} from "./internal-runtime.js";

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("bundled runtime descriptors", () => {
  afterEach(() => {
    delete process.env[BUNDLED_NODE_ENV];
    delete process.env[BUNDLED_GIT_ENV];
    delete process.env[BUNDLED_BASH_ENV];
  });

  it("reads the bundled Node/Git/Bash descriptors when advertised", () => {
    withEnv(
      {
        [BUNDLED_NODE_ENV]: String.raw`C:\PiAbyss\resources\node\node.exe`,
        [BUNDLED_GIT_ENV]: String.raw`C:\PiAbyss\resources\git\cmd\git.exe`,
        [BUNDLED_BASH_ENV]: String.raw`C:\PiAbyss\resources\git\bin\bash.exe`,
      },
      () => {
        expect(bundledNodeExecutable()).toBe(String.raw`C:\PiAbyss\resources\node\node.exe`);
        expect(bundledGitExecutable()).toBe(String.raw`C:\PiAbyss\resources\git\cmd\git.exe`);
        expect(bundledBashExecutable()).toBe(String.raw`C:\PiAbyss\resources\git\bin\bash.exe`);
      },
    );
  });

  it("returns undefined when descriptors are absent or empty", () => {
    withEnv(
      { [BUNDLED_GIT_ENV]: "", [BUNDLED_NODE_ENV]: undefined, [BUNDLED_BASH_ENV]: undefined },
      () => {
        expect(bundledNodeExecutable()).toBeUndefined();
        expect(bundledGitExecutable()).toBeUndefined();
        expect(bundledBashExecutable()).toBeUndefined();
      },
    );
  });
});
