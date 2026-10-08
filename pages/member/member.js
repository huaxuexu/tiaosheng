// pages/member/member.js —— 会员权益：成长会员等级与权益网格
const records = require('../../utils/records.js');
const member = require('../../utils/member.js');
const ui = require('../../utils/ui.js');

Page({
  data: {
    statusBarH: 26,
    tier: { lv: 1, name: '萌新会员', color: '#9aa0a6', nextName: '青铜会员', progress: 0, remain: 300 },
    stats: { count: 0, sessions: 0, streak: 0 },
    benefits: [],
    unlockedCount: 0,
    totalCount: 0,
  },

  onLoad() {
    this.setData({ statusBarH: ui.statusBarH() });
  },

  onShow() {
    this.reload();
  },

  // 自定义导航下自己实现返回：无上一页时退回「我的」
  navBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/profile/profile' });
  },

  reload() {
    const total = records.total();
    const tierInfo = member.computeMemberTier(total.count);
    const { list, unlocked, total: tCount } = member.buildBenefits(total.count);
    this.setData({
      tier: {
        lv: tierInfo.lv,
        name: tierInfo.name,
        color: tierInfo.color,
        nextName: tierInfo.nextName,
        progress: tierInfo.progress,
        remain: tierInfo.remain,
      },
      stats: {
        count: total.count,
        sessions: total.sessions,
        streak: records.streak(),
      },
      benefits: list,
      unlockedCount: unlocked,
      totalCount: tCount,
    });
  },
});
