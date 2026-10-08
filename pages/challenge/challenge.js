// pages/challenge/challenge.js —— 挑战页（由训练记录实时派生进度）
const records = require('../../utils/records.js');
const ui = require('../../utils/ui.js');

// 根据当前训练记录计算每个挑战的进度与完成态
function buildChallenges() {
  const total = records.total();
  const totalRope = records.totalBySport('rope');
  const week = records.aggregate('week');
  const streak = records.streak();
  const best = records.bestCount();
  const durationMin = Math.round(total.durationSec / 60);

  const defs = [
    { id: 'first',    icon: 'sparkles', title: '初次训练', desc: '完成第 1 次训练',           target: 1,    cur: total.sessions,            unit: '次' },
    { id: 'hundred',  icon: 'medal',    title: '百跳小将', desc: '单组跳满 100 个',           target: 100,  cur: best,                       unit: '个' },
    { id: 'week3',    icon: 'activity',  title: '周常达人', desc: '本周训练 3 次',               target: 3,    cur: week.sessions,              unit: '次' },
    { id: 'streak7',  icon: 'calendar', title: '七日打卡', desc: '连续训练 7 天',               target: 7,    cur: streak,                     unit: '天' },
    { id: 'krope',    icon: 'flame',    title: '千跳王者', desc: '累计跳绳 1000 个',           target: 1000, cur: totalRope.count,            unit: '个' },
    { id: 'time30',   icon: 'clock',    title: '坚持30分', desc: '累计训练 30 分钟',           target: 30,   cur: durationMin,                unit: '分' },
  ];

  const list = defs.map((d) => {
    const pct = Math.max(0, Math.min(100, Math.round((d.cur / d.target) * 100)));
    const done = d.cur >= d.target;
    return Object.assign({}, d, { pct, done });
  });
  const doneCount = list.filter((c) => c.done).length;
  return { list, doneCount, total: defs.length };
}

Page({
  data: {
    statusBarH: 26,
    capsuleRpx: 188,
    isLogin: false,          // 登录门控：未登录只做「锁定预览」，不展示进度
    headSub: '建立档案后开始记录挑战进度',
    pct: 0,
    challenges: [],
    doneCount: 0,
    totalCount: 0,
    hasRecord: false,
  },

  onLoad() {
    this.setData({ statusBarH: ui.statusBarH(), capsuleRpx: ui.capsuleRpx() });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.reload();
  },

  reload() {
    const isLogin = records.isLoggedIn();
    const { list, doneCount, total } = buildChallenges();
    this.setData({
      isLogin,
      headSub: isLogin
        ? '已完成 ' + doneCount + ' / ' + total + ' 个挑战'
        : '建立档案后开始记录挑战进度',
      challenges: list,
      doneCount,
      totalCount: total,
      pct: total ? Math.round((doneCount / total) * 100) : 0,
      // 未登录时「有没有记录」本身也不该暴露（那是时间纵深），统一走锁定态
      hasRecord: isLogin && records.total().sessions > 0,
    });
  },

  goTrain() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  // 锁定态引导：切到「我的」tab 建立档案
  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },
});
