/**
 * 备忘速记小窗（memo-widget）的独立入口。
 *
 * 与主入口（main.tsx）的关键差异：不加载 xterm / katex / streamdown 等
 * 重资源，只渲染 MemoWidget 一个组件树，保证小窗即点即开。
 */
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { MemoWidget } from "./features/memo/widget/MemoWidget";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

type WidgetErrorBoundaryState = { error: Error | null };

class WidgetErrorBoundary extends Component<{ children: ReactNode }, WidgetErrorBoundaryState> {
  state: WidgetErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WidgetErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("PiAbyss memo widget render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted">
          小窗渲染出错，请通过托盘「Memo」重新唤出。
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(root).render(
  <StrictMode>
    <WidgetErrorBoundary>
      <MemoWidget />
    </WidgetErrorBoundary>
  </StrictMode>,
);
