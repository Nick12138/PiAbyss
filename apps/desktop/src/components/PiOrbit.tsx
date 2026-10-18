/**
 * 等待用的「环绕」标记：白色 π + 两圈极淡的轨道 + 两颗反向绕行的光点。
 *
 * 工作区切换（`WorkspaceLoading`）和小精灵页的取用等待共用同一个、同一个尺寸：
 * 从切工作区到小精灵落位是连续发生的，中间不换锚点也不换大小，视线就不用
 * 重新找一次。
 *
 * 组件本身不含任何文字——状态由调用方用 `sr-only` 提供给读屏软件。
 */
import { PiMark } from "./PiMark";
import "./pi-orbit.css";

export function PiOrbit({ className = "" }: { className?: string }) {
  return (
    <div className={`pi-orbit ${className}`.trim()} aria-hidden="true">
      <div className="pi-orbit-halo" />
      <span className="pi-orbit-path p1" />
      <span className="pi-orbit-path p2" />
      <span className="pi-orbit-orb o1">
        <i />
      </span>
      <span className="pi-orbit-orb o2">
        <i />
      </span>
      <PiMark className="pi-orbit-mark size-14" />
    </div>
  );
}
