import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const tauriVersion = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).version as string;

export default defineConfig({
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(tauriVersion),
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
