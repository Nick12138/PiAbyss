import { describe, expect, it } from "vitest";
import capability from "../../src-tauri/capabilities/default.json";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("Tauri shell-open policy", () => {
  const plugins = tauriConfig.plugins as {
    shell?: { open?: unknown };
  };

  it("grants IPC only to the configured local development origin", () => {
    const build = tauriConfig.build as { devUrl?: unknown };
    const remote = capability.remote as { urls?: unknown } | undefined;

    expect(build.devUrl).toBe("http://127.0.0.1:1420");
    expect(remote?.urls).toEqual([`${build.devUrl}/*`]);
  });

  it("enforces HTTP and HTTPS through the shell plugin config", () => {
    expect(plugins.shell?.open).toBe("https?://\\S+");
  });

  it("accepts intentional URLs and rejects other shell-open targets", () => {
    const openPolicy = plugins.shell?.open;
    if (typeof openPolicy !== "string") {
      throw new TypeError("shell open policy must be a regex string");
    }

    const validator = new RegExp(`^(?:${openPolicy})$`);
    const allowed = [
      "https://example.com/oauth/authorize?client_id=piabyss#consent",
      "http://127.0.0.1:43123/callback?code=abc",
    ];
    const rejected = [
      "mailto:team@example.com",
      "tel:+1234567890",
      "file:///tmp/piabyss",
      "javascript:alert(1)",
      "vscode://settings",
      "../relative/path",
      "https://",
      "https://example.com/has raw whitespace",
    ];

    expect(allowed.every((url) => validator.test(url))).toBe(true);
    expect(rejected.some((url) => validator.test(url))).toBe(false);
  });

  it("grants shell open without an ineffective ACL scope", () => {
    const permissions = capability.permissions as readonly unknown[];
    const shellOpenPermissions = permissions.filter((permission) => {
      if (permission === "shell:allow-open") {
        return true;
      }
      return (
        typeof permission === "object" &&
        permission !== null &&
        "identifier" in permission &&
        permission.identifier === "shell:allow-open"
      );
    });

    expect(shellOpenPermissions).toEqual(["shell:allow-open"]);
  });
});
