/**
 * 容器宽度是否达到双栏阈值（Tailwind @2xl = 672px）。
 *
 * 用于「宽屏左列表右详情 / 窄屏单栏互斥」的 master-detail 布局
 * （备忘录、周期计划等内嵌页）。页面嵌在主对话区里，宽度 ≠ 窗口宽度，
 * 所以用 ResizeObserver 量容器本身，而不是 matchMedia。
 * CSS 侧用同断点的容器查询变体（@2xl:）控制显隐，JS 侧只负责交互决策。
 */
import { useEffect, useState, type RefObject } from "react";

export function useContainerWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setWide((entries[0]?.contentRect.width ?? el.clientWidth) >= 672);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}
