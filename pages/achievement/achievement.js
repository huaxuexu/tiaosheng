// pages/achievement/achievement.js —— 成就页（等级 + 徽章，由训练记录实时派生）
const records = require('../../utils/records.js');
const ui = require('../../utils/ui.js');

// 等级分档：按累计跳绳个数
const LEVEL_TIERS = [
  { lv: 1, name: '萌新', min: 0 },
  { lv: 2, name: '进阶', min: 300 },
  { lv: 3, name: '达人', min: 1000 },
  { lv: 4, name: '高手', min: 5000 },
  { lv: 5, name: '王者', min: 20000 },
];

function computeLevel(ropeCount) {
  let cur = LEVEL_TIERS[0];
  for (const t of LEVEL_TIERS) if (ropeCount >= t.min) cur = t;
  const next = LEVEL_TIERS.find((t) => t.min > cur.min) || null;
  const progress = next
    ? Math.max(0, Math.min(100, Math.round(((ropeCount - cur.min) / (next.min - cur.min)) * 100)))
    : 100;
  return {
    lv: cur.lv,
    name: cur.name,
    nextName: next ? next.name : '已满级',
    nextMin: next ? next.min : 0,
    progress,
  };
}

// 8 个成就徽章的解锁判定
function buildAchievements() {
  const total = records.total();
  const totalRope = records.totalBySport('rope');
  const streak = records.streak();
  const best = records.bestCount();
  const durationMin = Math.round(total.durationSec / 60);
  const hasRope = records.hasSport('rope');
  const hasVolley = records.hasSport('volleyball');

  const defs = [
    { id: 'first',    icon: 'sparkles', name: '初次训练', desc: '完成第 1 次训练',                 unlocked: total.sessions >= 1 },
    { id: 'hundred',  icon: 'medal',    name: '百跳达成', desc: '单组跳满 100 个',                 unlocked: best >= 100 },
    { id: 'krope',    icon: 'flame',    name: '千跳达成', desc: '累计跳绳 1000 个',                 unlocked: totalRope.count >= 1000 },
    { id: 'wrope',    icon: 'star',     name: '万跳达成', desc: '累计跳绳 10000 个',                unlocked: totalRope.count >= 10000 },
    { id: 'streak7',  icon: 'calendar', name: '七日打卡', desc: '连续训练 7 天',                     unlocked: streak >= 7 },
    { id: 'master30', icon: 'trophy',   name: '训练达人', desc: '累计训练 30 次',                   unlocked: total.sessions >= 30 },
    { id: 'time60',   icon: 'clock',    name: '时光跑者', desc: '累计训练 60 分钟',                 unlocked: durationMin >= 60 },
    { id: 'allround', icon: 'dumbbell', name: '全能选手', desc: '跳绳与垫排球都练过',               unlocked: hasRope && hasVolley },
  ];

  const unlocked = defs.filter((d) => d.unlocked).length;
  return { list: defs, unlocked, total: defs.length };
}

Page({
  data: {
    statusBarH: 26,
    isLogin: false,     // 登录门控：未登录时等级与徽章整体走锁定态
    headSub: '建立档案后可查看累计数据',
    lvText: 'Lv.—',
    level: { lv: 1, name: '萌新', nextName: '进阶', nextMin: 300, progress: 0 },
    levelTitle: '未建立档案',
    nextHint: '',
    ropeCount: 0,
    badges: [],
    unlockedCount: 0,
    totalCount: 0,
  },

  onLoad() {
    this.setData({ statusBarH: ui.statusBarH() });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    this.reload();
  },

  reload() {
    const isLogin = records.isLoggedIn();
    const totalRope = records.totalBySport('rope');
    const { list, unlocked, total } = buildAchievements();
    const level = computeLevel(totalRope.count);
    this.setData({
      isLogin,
      headSub: isLogin
        ? '累计跳绳 ' + totalRope.count + ' 个'
        : '建立档案后可查看累计数据',
      // 未登录时等级显示为 Lv.—：算出来的 Lv.1 会被读成「你已经是萌新了」
      lvText: isLogin ? 'Lv.' + level.lv : 'Lv.—',
      level,
      levelTitle: isLogin ? '跳绳' + level.name : '未建立档案',
      nextHint: isLogin
        ? (level.nextMin
            ? '距「跳绳' + level.nextName + '」还差 ' + (level.nextMin - totalRope.count) + ' 个'
            : '已达到最高等级')
        : '建立档案后开始记录等级与徽章',
      ropeCount: totalRope.count,
      // 未登录时全部按未解锁渲染（复用 .badge-chip.off 的灰底灰字），进度数值不外泄
      badges: isLogin ? list : list.map((b) => Object.assign({}, b, { unlocked: false })),
      unlockedCount: isLogin ? unlocked : 0,
      totalCount: total,
    });
  },
});
