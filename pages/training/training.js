// pages/training/training.js —— 我的训练：真实记录与统计
const records = require('../../utils/records.js');
const ui = require('../../utils/ui.js');

const SPORTS = [
  { key: 'all', name: '全部' },
  { key: 'rope', name: '跳绳' },
  { key: 'volleyball', name: '垫排球' },
];
// icon 必须是 components/icon/icons.js 里存在的键
const SPORT_META = {
  rope: { name: '跳绳', icon: 'activity' },
  volleyball: { name: '垫排球', icon: 'target' },
};

const { pad, fmtDuration } = require('../../utils/format.js');
function fmtDate(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 构建历史记录列表（按时间倒序），sport='all' 时不过滤
// 走 getVisible()：未登录时不展示历史明细（与数据页门控一致）。
// 该页入口只在已登录时出现在数据页，这里再兜一层，保证「不展示不该展示的历史」在任何路径下都成立。
function buildList(sport) {
  const all = records.getVisible().slice().sort((a, b) => b.ts - a.ts);
  return all
    .filter((r) => sport === 'all' || r.sport === sport)
    .map((r) => {
      const meta = SPORT_META[r.sport] || { name: r.sport, icon: 'dumbbell' };
      return {
        id: r.ts + '_' + r.sport,
        date: fmtDate(r.ts),
        sportName: meta.name,
        sportIcon: meta.icon,
        count: r.count || 0,
        duration: fmtDuration(r.durationSec || 0),
      };
    });
}

Page({
  data: {
    statusBarH: 26,
    sports: SPORTS,
    sport: 'all',
    stat: { count: 0, sessions: 0, durationText: '0秒', streak: 0 },
    list: [],
    empty: true,
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
    // 顶部统计跟随运动筛选；连续天数为全局口径
    const base = this.data.sport === 'all' ? records.total() : records.totalBySport(this.data.sport);
    const list = buildList(this.data.sport);
    this.setData({
      stat: {
        count: base.count,
        sessions: base.sessions,
        durationText: fmtDuration(base.durationSec),
        streak: records.streak(),
      },
      list,
      empty: list.length === 0,
    });
  },

  switchSport(e) {
    const sport = e.currentTarget.dataset.key;
    if (sport === this.data.sport) return;
    this.setData({ sport });
    this.reload();
  },

  goTrain() {
    wx.switchTab({ url: '/pages/home/home' });
  },
});
