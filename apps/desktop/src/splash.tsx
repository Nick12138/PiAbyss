/**
 * 启动开屏（splash）的独立入口。
 *
 * 与主入口（main.tsx）的关键差异：不加载 xterm / katex / streamdown / i18n
 * 词表等任何重资源，只渲染 SplashApp 一棵极小的树。开屏必须在 Host 起来之前
 * 就完成首帧——这里每多一个依赖，都是直接扣在用户等待时间上的。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SplashApp } from "./splash/SplashApp";
import "./styles/splash.css";

const root = document.getElementById("root");
if (!root) throw new Error("splash root element missing");

createRoot(root).render(
  <StrictMode>
    <SplashApp />
  </StrictMode>,
);
