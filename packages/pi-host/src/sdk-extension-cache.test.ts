import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

type CacheState = { imports: number; factories: number };

const roots: string[] = [];
const globalState = globalThis as typeof globalThis & Record<string, unknown>;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The 0.80.7 patch kept the SDK's extension module cache across reloads and
 * added a preserveExtensionCache option. The 0.82.1 patch drops both, so this
 * now pins the upstream contract PiAbyss depends on: every reload re-imports the
 * extension module and rebuilds its handlers.
 */
describe("SDK extension module cache", () => {
  it("re-imports the extension module on every reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-extension-cache-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "cache-extension.js");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    const stateKey = `__piabyss_extension_cache_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    globalState[stateKey] = { imports: 0, factories: 0 } satisfies CacheState;
    writeFileSync(
      extensionPath,
      [
        `const state = globalThis[${JSON.stringify(stateKey)}];`,
        "state.imports += 1;",
        "export default function (pi) {",
        "  state.factories += 1;",
        "  pi.on(\"resources_discover\", async () => ({ promptPaths: [] }));",
        "}",
      ].join("\n"),
    );

    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
        additionalExtensionPaths: [extensionPath],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();
      const first = loader.getExtensions();
      expect(first.errors).toEqual([]);
      expect(first.extensions).toHaveLength(1);
      expect(first.extensions[0]!.handlers.has("resources_discover")).toBe(true);
      expect(globalState[stateKey]).toEqual({ imports: 1, factories: 1 });

      await loader.reload();
      const second = loader.getExtensions();
      expect(second.errors).toEqual([]);
      expect(second.extensions).toHaveLength(1);
      expect(second.extensions[0]).not.toBe(first.extensions[0]);
      expect(second.extensions[0]!.handlers.has("resources_discover")).toBe(true);
      expect(globalState[stateKey]).toEqual({ imports: 2, factories: 2 });

      await loader.reload();
      const third = loader.getExtensions();
      expect(third.errors).toEqual([]);
      expect(third.extensions[0]!.handlers.has("resources_discover")).toBe(true);
      expect(globalState[stateKey]).toEqual({ imports: 3, factories: 3 });
    } finally {
      delete globalState[stateKey];
    }
  });
});
