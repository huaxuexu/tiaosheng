// pages/agreement/agreement.js —— 协议全文页（用户协议 / 隐私政策）
const ui = require('../../utils/ui.js');

Page({
  data: {
    statusBarH: 26,
    type: 'privacy',
    title: '隐私政策',
  },

  onLoad(options) {
    const type = options.type === 'user' ? 'user' : 'privacy';
    this.setData({
      type,
      title: type === 'user' ? '用户协议' : '隐私政策',
      statusBarH: ui.statusBarH(),
    });
    wx.setNavigationBarTitle({ title: type === 'user' ? '用户协议' : '隐私政策' });
  },

  // 页内切换协议（不再跳页）
  switchType(e) {
    const type = e.currentTarget.dataset.type === 'user' ? 'user' : 'privacy';
    if (type === this.data.type) return;
    this.setData({ type, title: type === 'user' ? '用户协议' : '隐私政策' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  // 自定义导航下自己实现返回：无上一页时退回首页
  navBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/home/home' });
  },
});
