/**
 * 开屏小窗的视觉与状态。
 *
 * 内容：品牌标 + 应用名 + 进度条 + 叙事化轮播文案。**不显示阶段提示**
 * （「正在启动 Pi Host」那类）——开屏期间用户无事可做，给点有温度的东西比给
 * 一行技术性状态好。阶段仍然被跟踪，它只决定进度条何时收尾、轮播何时停下。
 *
 * 文案在 splash-copy.ts 里自带 zh / en 两套，刻意不引 `lib/i18n`
 * （那份词表约 220KB，对「必须在 Host 起来之前完成首帧」的窗口来说太重）。
 */
import { useEffect, useRef, useState } from "react";
import piMarkDark from "../assets/pi-mark-dark.png";
import piMarkLight from "../assets/pi-mark-light.png";
import {
  NARRATIVE,
  NARRATIVE_FADE_MS,
  NARRATIVE_INTERVAL_MS,
  STAGE_RANK,
  isSplashStage,
  shuffled,
  systemLocale,
  type SplashStage,
} from "./splash-copy";

type SplashContextPayload = { language: string | null; stage: string };

export function SplashApp() {
  const [stage, setStage] = useState<SplashStage>("preparing");
  const [lines, setLines] = useState<readonly string[]>(() => shuffled(NARRATIVE[systemLocale()]));
  const [lineIndex, setLineIndex] = useState(0);
  const [switching, setSwitching] = useState(false);
  // 初值 -1：第一次收到的任何阶段都算前进。
  const rankRef = useRef(-1);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const applyStage = (value: unknown): void => {
      if (!isSplashStage(value)) return;
      const rank = STAGE_RANK[value];
      if (rank < rankRef.current) return;
      rankRef.current = rank;
      setStage(value);
    };

    void (async () => {
      const { invoke, isTauri } = await import("@tauri-apps/api/core");
      // 浏览器里跑 Vite dev：没有宿主可通知，停在初始阶段即可。
      if (!isTauri() || disposed) return;

      // 先拉一次：Rust 在 splash 的 JS 加载完成之前就广播了 `starting-host`，
      // 那条事件必然丢失，只能靠这次拉取补上。
      try {
        const context = await invoke<SplashContextPayload>("splash_context");
        if (disposed) return;
        if (context.language === "zh" || context.language === "en") {
          // 语言与系统判断不同就换一套文案并重新洗牌，否则会中英混着轮播。
          setLines(shuffled(NARRATIVE[context.language]));
          setLineIndex(0);
        }
        applyStage(context.stage);
      } catch {
        // 宿主尚未注册好命令时保持初始阶段，后续事件会补上。
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<{ stage?: string }>("splash-stage", (event) => {
          applyStage(event.payload?.stage);
        });
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        // 拿不到事件通道不影响开屏本身，保底时长后仍会被交接。
      }

      // 首帧已经画出来了才通知宿主上屏，避免「窗口先出现、内容再闪一下」。
      if (disposed) return;
      try {
        await invoke("splash_ready");
      } catch {
        // 上屏失败时看门狗仍会兜底交接。
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 叙事文案轮播：先淡出、换句、再淡入。`ready` 之后停轮播——主窗口即将上屏，
  // 让最后一句定住比继续翻页更像「到站了」。
  useEffect(() => {
    if (lines.length < 2 || stage === "ready") return;
    const timer = window.setInterval(() => {
      setSwitching(true);
      window.setTimeout(() => {
        setLineIndex((index) => (index + 1) % lines.length);
        setSwitching(false);
      }, NARRATIVE_FADE_MS);
    }, NARRATIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [lines, stage]);

  const narrative = lines[lineIndex] ?? "";

  return (
    <div className="splash-card" data-tauri-drag-region data-splash data-splash-stage={stage}>
      <div className="splash-mark" aria-hidden="true">
        <img className="splash-mark-light" src={piMarkLight} alt="" draggable={false} />
        <img className="splash-mark-dark" src={piMarkDark} alt="" draggable={false} />
      </div>
      <p className="splash-wordmark">PiAbyss</p>
      <div className="splash-bar" aria-hidden="true">
        <span />
      </div>
      {/* role="status" 保留：屏幕阅读器仍需知道开屏在进行中，只是不再念技术细节。 */}
      <p
        className="splash-narrative"
        role="status"
        aria-live="polite"
        data-switching={switching ? "true" : "false"}
      >
        {narrative}
      </p>
    </div>
  );
}
