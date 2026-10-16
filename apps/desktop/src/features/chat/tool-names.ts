/**
 * Tool-name predicates shared by the chat tool cards.
 *
 * Kept dependency-free on purpose: both the generic `ToolCard` and the
 * specialized cards import from here, so it must not pull either of them in.
 */

const WEB_SEARCH_NAMES = new Set([
  "search",
  "web_search",
  "search_web",
  "google_search",
  "brave_search",
  "tavily_search",
  "exa_search",
]);

/** Filesystem searches keep their own card and must not claim the web label. */
const NON_WEB_SEARCH_NAMES = new Set(["file_search", "find", "grep", "glob"]);

/** True for tools that search the web, as opposed to the filesystem. */
export function isWebSearchTool(name: string): boolean {
  const normalized = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, "_");
  if (NON_WEB_SEARCH_NAMES.has(normalized)) return false;
  return (
    WEB_SEARCH_NAMES.has(normalized) ||
    normalized.includes("web_search") ||
    normalized.includes("search_web")
  );
}
