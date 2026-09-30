/**
 * 把 <img> 展示的图片复制进系统剪贴板。
 *
 * 图片在界面里可能来自 data: / blob: / 打包资源 URL，而剪贴板需要的是
 * 位图或编码字节，所以统一经 <canvas> 重新取像素：
 * - Tauri（桌面端）：canvas → PNG bytes → Image.fromBytes（需要 image-png
 *   Cargo feature）→ clipboard-manager 的 writeImage，真正进系统剪贴板。
 * - Web：canvas → PNG blob → ClipboardItem，走 Web Clipboard API。
 *
 * 在 Tauri 下永远走原生路径：WebView 的 navigator.clipboard.write 写入的
 * 自定义格式拿不到系统级位图，只有原生插件写入才对其他应用可见。
 */
import { isTauri } from "@tauri-apps/api/core";
/** 超大图先压到画布上限，避免剪贴板/内存被一次性撑爆。 */
const MAX_DIMENSION = 8192;

/** 把任意图片 URL（data:/blob:/http(s)/打包资源）解码并绘到画布上。 */
async function decodeToCanvas(url: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`image load failed: ${url.slice(0, 64)}`));
    image.src = url;
  });
  const naturalWidth = image.naturalWidth || 1;
  const naturalHeight = image.naturalHeight || 1;
  const ratio = Math.min(1, MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(naturalHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas PNG encoding failed");
  return blob;
}

/** 复制成功返回 true；图片解码失败 / 剪贴板不可用时返回 false。 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  try {
    const canvas = await decodeToCanvas(url);
    if (isTauri()) {
      const blob = await canvasPngBlob(canvas);
      const [{ invoke }, { Image: TauriImage }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/image"),
      ]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const resource = await TauriImage.fromBytes(bytes);
      try {
        await invoke("plugin:clipboard-manager|write_image", { image: resource.rid });
      } finally {
        // 资源关闭失败不应让复制动作报错；无 close（老版本 mock/异常环境）时跳过。
        await resource.close?.().catch?.(() => undefined);
      }
      return true;
    }
    const blob = await canvasPngBlob(canvas);
    const ClipboardItemCtor = window.ClipboardItem;
    if (!ClipboardItemCtor || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

export type ImageCopyMenuOptions = {
  url: string;
  label: string;
  labelFailed: string;
  notifySuccess: (message: string) => void;
  notifyFailure: (message: string) => void;
};

/**
 * 「复制图片」右键菜单项：统一处理复制动作与成功/失败通知，
 * 各图片预览面传入自己的文案与通知通道即可。
 */
export function buildImageCopyMenuItem(options: ImageCopyMenuOptions): {
  id: string;
  label: string;
  onSelect: () => Promise<void>;
} {
  return {
    id: "image.copy",
    label: options.label,
    onSelect: async () => {
      const copied = await copyImageToClipboard(options.url);
      if (copied) {
        options.notifySuccess(options.label);
      } else {
        options.notifyFailure(options.labelFailed);
      }
    },
  };
}
