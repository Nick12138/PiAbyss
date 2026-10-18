/**
 * 工作区切换时的等待态。
 *
 * 屏幕上不写字：切换工作区是高频操作，一句「马上就好。」既不给信息，又会被
 * 反复看到。这里只留两个动效——背景里慢慢下沉的光点（工作区还在往下长）、
 * 绕着 π 转的两颗光点（还在转，不是卡住了）。
 *
 * 文字只剩给读屏软件的那一句（`chatWorkspaceServicesNotReady`），视觉上不占位；
 * `host.lastError` 仍然会落到底部——那是切换真失败时唯一的线索。
 */
import type { CSSProperties } from "react";
import { PiOrbit } from "../../components/PiOrbit";
import { useT } from "../../lib/i18n/use-t";
import "./workspace-loading.css";

type StyleVars = CSSProperties & Record<string, string | number>;

/**
 * 背景光点。位置/大小/速度由固定种子生成：每次切换工作区看到的都是同一片，
 * 不会因为重新挂载而「换一批星星」，也让动效可复现（截图、回归对比都靠它）。
 */
function buildMotes(): StyleVars[] {
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 46 }, () => ({
    "--ws-x": `${(2 + rnd() * 94).toFixed(1)}%`,
    "--ws-s": `${4 + Math.round(rnd() * 9)}px`,
    "--ws-dur": `${(17 + rnd() * 24).toFixed(1)}s`,
    "--ws-delay": `-${(rnd() * 40).toFixed(1)}s`,
    "--ws-drift": `${(6 + rnd() * 8).toFixed(1)}s`,
    "--ws-d2": `-${(rnd() * 9).toFixed(1)}s`,
    "--ws-o": (0.24 + rnd() * 0.34).toFixed(2),
    "--ws-b": `${(0.15 + rnd() * 0.75).toFixed(2)}px`,
  }));
}

const MOTES = buildMotes();

export function WorkspaceLoading({ error }: { error?: string | null }) {
  const t = useT();
  return (
    <div className="ws-loading" data-workspace-loading>
      <div className="ws-loading-motes" aria-hidden="true">
        {MOTES.map((style, index) => (
          <i key={index} className="ws-loading-mote" style={style} />
        ))}
        <div className="ws-loading-floor" />
      </div>
      <div className="ws-loading-veil" aria-hidden="true" />
      <PiOrbit />
      <p className="sr-only" role="status" aria-live="polite">
        {t("chatWorkspaceServicesNotReady")}
      </p>
      {error ? <p className="ws-loading-error">{error}</p> : null}
    </div>
  );
}
