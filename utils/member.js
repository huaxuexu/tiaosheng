// utils/member.js —— 成长会员体系（免费，按累计训练升级）
//
// 设计说明：
// - 本体系基于「累计训练总个数」（含全部运动），代表会员整体成长；
// - 与「成就页」的跳绳等级相互独立（成就页只看累计跳绳个数，代表跳绳专项）。
//   两者阈值对齐，降低用户认知负担。
// - 全部本地数据驱动，无需后端 / 支付。

const records = require('./records.js');

// 会员等级分档（按累计训练总个数）
const MEMBER_TIERS = [
  { lv: 1, name: '萌新会员', min: 0,     color: '#9aa0a6' },
  { lv: 2, name: '青铜会员', min: 300,   color: '#cd7f32' },
  { lv: 3, name: '白银会员', min: 1000,  color: '#aeb6bf' },
  { lv: 4, name: '黄金会员', min: 5000,  color: '#f0a500' },
  { lv: 5, name: '王者会员', min: 20000, color: '#FF4E2A' },
];

// 根据累计总个数计算当前会员等级与升级进度
function computeMemberTier(totalCount) {
  let cur = MEMBER_TIERS[0];
  for (const t of MEMBER_TIERS) if (totalCount >= t.min) cur = t;
  const next = MEMBER_TIERS.find((t) => t.min > cur.min) || null;
  const progress = next
    ? Math.max(0, Math.min(100, Math.round(((totalCount - cur.min) / (next.min - cur.min)) * 100)))
    : 100;
  const remain = next ? Math.max(0, next.min - totalCount) : 0;
  return {
    lv: cur.lv,
    name: cur.name,
    color: cur.color,
    min: cur.min,
    nextName: next ? next.name : '已至最高等级',
    nextMin: next ? next.min : 0,
    progress,
    remain,
  };
}

// 会员权益清单：reqLv 为解锁所需会员等级。每一项都对应 App 内的真实能力。
const MEMBER_BENEFITS = [
  { id: 'count',     icon: 'target',    name: '精准计数',     reqLv: 1, desc: '双模型视觉计数，跳绳 / 垫排球皆支持' },
  { id: 'save',      icon: 'save',      name: '训练本地存档', reqLv: 1, desc: '所有训练记录安全保存在本机' },
  { id: 'data',      icon: 'bar-chart', name: '数据看板',     reqLv: 1, desc: '按日 / 周 / 月查看训练趋势' },
  { id: 'multi',     icon: 'dumbbell',  name: '多运动支持',   reqLv: 1, desc: '跳绳与垫排球双项目训练档案' },
  { id: 'train',     icon: 'clipboard', name: '我的训练档案', reqLv: 2, desc: '独立页面查看历史记录与统计' },
  { id: 'challenge', icon: 'flag',      name: '挑战系统',     reqLv: 2, desc: '解锁 6 大训练挑战，冲刺目标' },
  { id: 'badge',     icon: 'award',     name: '成就徽章',     reqLv: 3, desc: '解锁 8 枚成就徽章与等级' },
  { id: 'grow',      icon: 'sprout',    name: '会员成长体系', reqLv: 3, desc: '训练越多，会员等级越高' },
];

// 根据累计总个数计算权益解锁状态
function buildBenefits(totalCount) {
  const tier = computeMemberTier(totalCount);
  const list = MEMBER_BENEFITS.map((b) => ({
    ...b,
    unlocked: tier.lv >= b.reqLv,
  }));
  const unlocked = list.filter((b) => b.unlocked).length;
  return { list, unlocked, total: list.length, tier };
}

module.exports = { MEMBER_TIERS, MEMBER_BENEFITS, computeMemberTier, buildBenefits };
