// utils/ui.js —— 顶部安全区工具
//
// 采用 navigationStyle:"custom" 的页面，需要自己避让系统状态栏；若页首右侧还要
// 放元素，还得避让微信右上角的「胶囊」（菜单按钮，尺寸固定 87×32px、右距 7px）。

// 状态栏高度 + 6px 呼吸位（返回 px，直接用于页面 style="padding-top:{{statusBarH}}px"）
function statusBarH() {
  try {
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
    const h = (info && info.statusBarHeight) || 20;
    return h + 6;
  } catch (e) {
    return 26;
  }
}

// 胶囊占位宽度（返回 rpx）：页首右侧元素需预留这段，避免被胶囊压住
function capsuleRpx() {
  try {
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
    const rect = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
    const w = info && info.windowWidth;
    if (rect && rect.left && w) {
      const px = w - rect.left + 6;                 // 距屏幕右边缘需要的 px（含 6px 间隙）
      return Math.round((px * 750) / w);            // px → rpx
    }
  } catch (e) {}
  return 188; // 兜底：375px 宽设备上胶囊占位 94px = 188rpx
}

module.exports = { statusBarH, capsuleRpx };
