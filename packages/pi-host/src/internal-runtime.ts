/**
 * Bundled runtime descriptors.
 *
 * The desktop launcher starts the Host with the user's own PATH (so Agent Bash
 * and internal children see mise, nvm, system git, …) and advertises the exact
 * bundled Node/Git/Bash executables through these environment variables. Host
 * code that needs the deterministic bundled tools reads them here instead of
 * relying on PATH placement.
 */

export const BUNDLED_NODE_ENV = "PIABYSS_BUNDLED_NODE";
export const BUNDLED_GIT_ENV = "PIABYSS_BUNDLED_GIT";
export const BUNDLED_BASH_ENV = "PIABYSS_BUNDLED_BASH";

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** node.exe the Host itself is running under, when the launcher advertised it. */
export function bundledNodeExecutable(): string | undefined {
  return envValue(BUNDLED_NODE_ENV);
}

/** git.exe shipped inside the app, when the launcher advertised it. */
export function bundledGitExecutable(): string | undefined {
  return envValue(BUNDLED_GIT_ENV);
}

/** bash.exe shipped with bundled Portable Git (clean-Windows fallback). */
export function bundledBashExecutable(): string | undefined {
  return envValue(BUNDLED_BASH_ENV);
}
