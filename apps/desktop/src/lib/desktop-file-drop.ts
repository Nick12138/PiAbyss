/**
 * 窗口级文件拖放的「归属者」计数。
 *
 * Tauri 把系统文件拖拽（`dragDropEnabled: true`）只交给 webview 事件，DOM 收不到；
 * 每个想接外部文件的宿主都自己 `getCurrentWebview().onDragDropEvent(...)` 挂一个监听，
 * 而这些监听**彼此不互斥**——同一次落下每一方都收得到。对话输入框常驻挂着一个（小精灵页
 * 就在背后），备忘弹窗再挂一个，拖一张图进去就会既进记录又进输入框的附件区。
 *
 * 所以由更上层、更临时的那个宿主在挂载期间认领这条通道，输入框看到有人认领就让路。
 * 用计数而不是布尔：理论上能叠两层浮层，各自退出时各自释放。
 */
let owners = 0;

/** 认领窗口级文件拖放，返回释放函数（重复调用释放函数只减一次）。 */
export function claimDesktopFileDrop(): () => void {
  owners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners = Math.max(0, owners - 1);
  };
}

/** 是否已有浮层宿主认领了这条通道。 */
export function hasDesktopFileDropOwner(): boolean {
  return owners > 0;
}
