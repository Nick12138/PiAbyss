/**
 * 小精灵专用工作区路径判断。
 *
 * 小精灵工作区是 Host 自有的真实目录（`<agentDir>/workspace/pixie`，可经
 * 插件配置 `PIABYSS_PIXIE_WORKSPACE` 覆盖），路径由 host 的 `pixie.ensureCurrent`
 * 返回。与 telegram-path 同理：Host 在 Windows 上统一小写化 workspace key，
 * 这里做同样的归一化比较，避免大小写差异让派生状态（ready 门控、工作区
 * 列表过滤）在切换后迟迟不翻转。
 */

function platformIsWindows(): boolean {
  return typeof navigator !== "undefined" && /^win/i.test(navigator.platform);
}

function normalizePixiePath(path: string): string {
  if (!platformIsWindows()) return path;
  // Host 在 Windows 上既会小写化 key，也可能给出 `\\` 分隔符（或与 UI 的 `/`
  // 混用）：比较前统一，否则同一个目录会被判成两个。
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 小精灵工作区的默认路径（`<agentDir>/workspace/pixie`）。仅用于比较与展示，
 *  不做 I/O；分隔符统一成 `/`，由 normalizePixiePath 负责平台归一化。 */
export function defaultPixieWorkspacePath(agentDir: string | null | undefined): string | null {
  if (!agentDir) return null;
  return `${agentDir.replace(/[\\/]+$/, "")}/workspace/pixie`;
}

/** 同路径比较（Windows 忽略大小写）；任一为空视为不同路径。 */
export function isSamePixiePath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizePixiePath(a) === normalizePixiePath(b);
}
