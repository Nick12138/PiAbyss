/**
 * 图片全屏放大预览（Lightbox）：点击各处的图片缩略图后打开。
 *
 * 能力：缩放（按钮 / 滚轮 / +、- 键）、适应窗口、1:1 原始尺寸、
 * 按住拖拽平移、ESC / 点击背景关闭。通过 createPortal 挂到 body，
 * 盖过普通 Dialog（z-index 更高）。
 */
import { X, ZoomIn, ZoomOut, Maximize, Scan } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n/use-t";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const SCALE_STEP = 0.25;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function ImageLightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const t = useT();
  // null = 适应窗口；数字 = 相对原始尺寸的缩放比例。
  const [scale, setScale] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        setScale((current) => clampScale((current ?? 1) + SCALE_STEP));
      } else if (event.key === "-") {
        setScale((current) => clampScale((current ?? 1) - SCALE_STEP));
      } else if (event.key === "0") {
        setScale(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 切换到「适应窗口」时重置平移；拖拽中不允许改动 scale/offset。
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
  }, [scale]);

  const onWheel = useCallback((event: ReactWheelEvent) => {
    setScale((current) => clampScale((current ?? 1) - event.deltaY * 0.002));
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [offset]);
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    setOffset({ x: state.baseX + (event.clientX - state.startX), y: state.baseY + (event.clientY - state.startY) });
  }, []);
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  function onKeyDown(event: ReactKeyboardEvent) {
    // 输入焦点落在遮罩内时也允许 Enter 关闭；防止事件继续冒泡触发下层界面。
    if (event.key === "Escape") event.stopPropagation();
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[60] flex flex-col bg-black/85"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="image-lightbox"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 px-3 text-foreground">
        <button
          type="button"
          title={t("fileZoomOut")}
          aria-label={t("fileZoomOut")}
          className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => setScale(clampScale((scale ?? 1) - SCALE_STEP))}
        >
          <ZoomOut size={16} />
        </button>
        <span className="w-14 text-center text-xs text-white/80" data-testid="image-lightbox-scale">
          {scale === null ? t("fileFit") : `${Math.round(scale * 100)}%`}
        </span>
        <button
          type="button"
          title={t("fileZoomIn")}
          aria-label={t("fileZoomIn")}
          className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => setScale(clampScale((scale ?? 1) + SCALE_STEP))}
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          title={t("fileFit")}
          aria-label={t("fileFit")}
          className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => setScale(null)}
        >
          <Maximize size={16} />
        </button>
        <button
          type="button"
          title={t("fileOriginalSize")}
          aria-label={t("fileOriginalSize")}
          className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          onClick={() => setScale(1)}
        >
          <Scan size={16} />
        </button>
        <span className="min-w-0 flex-1 truncate px-2 text-xs text-white/60">{alt}</span>
        <button
          type="button"
          title={t("imagePreviewClose")}
          aria-label={t("imagePreviewClose")}
          data-testid="image-lightbox-close"
          className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        onWheel={onWheel}
      >
        {error ? (
          <p role="alert" className="text-sm text-white/70">
            {t("fileMediaFailed")}
          </p>
        ) : (
          <img
            src={url}
            alt={alt}
            draggable={false}
            onError={() => setError(true)}
            data-testid="image-lightbox-image"
            className={`touch-none select-none ${scale === null ? "max-h-full max-w-full object-contain" : ""}`}
            style={
              scale === null
                ? undefined
                : {
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                    maxWidth: "none",
                  }
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 轻量的 lightbox 状态钩子：返回 [请求对象, 打开, 关闭, 渲染节点]。
 * 各页面持有 url/alt 状态后只需在图片 onClick 中调用 open(url, alt)。
 */
export function useImageLightbox(): {
  lightbox: { url: string; alt: string } | null;
  open: (url: string, alt: string) => void;
  close: () => void;
  element: React.ReactNode;
} {
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  const open = useCallback((url: string, alt: string) => setLightbox({ url, alt }), []);
  const close = useCallback(() => setLightbox(null), []);
  const element = lightbox ? <ImageLightbox url={lightbox.url} alt={lightbox.alt} onClose={close} /> : null;
  return { lightbox, open, close, element };
}

/** 可点击的图片缩略图：点击后全屏放大预览（lightbox 状态由组件内部持有）。 */
export function LightboxImage({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  className: string;
}) {
  const { open, element } = useImageLightbox();
  return (
    <>
      <img
        src={url}
        alt={alt}
        className={`${className} cursor-zoom-in`}
        data-testid="lightbox-image-trigger"
        onClick={() => open(url, alt)}
      />
      {element}
    </>
  );
}
