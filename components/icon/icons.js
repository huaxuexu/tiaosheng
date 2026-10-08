// components/icon/icons.js
// 统一线性图标库（Lucide/Feather 风格，24x24，品牌色 #FF4E2A）
// 每个图标为 { vb: viewBox, inner: 内部 SVG 元素, sw: stroke-width }
// buildSvg(name, color) 返回可直接用于 background-image 的 data URI。
// 采用 URL-encoded（非 base64）以保证源码可读、便于维护。

const BRAND = '#FF4E2A';

const ICONS = {
  // 运动（首页 / tab）
  activity: {
    vb: '0 0 24 24',
    inner: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  },
  // 数据
  'bar-chart': {
    vb: '0 0 24 24',
    inner:
      '<line x1="3" y1="20" x2="21" y2="20"/><line x1="6" y1="20" x2="6" y2="13"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="9"/>',
  },
  // 挑战
  flag: {
    vb: '0 0 24 24',
    inner: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  },
  // 成就
  trophy: {
    vb: '0 0 24 24',
    inner:
      '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M5 4H3v2a3 3 0 0 0 3 3"/><path d="M19 4h2v2a3 3 0 0 1-3 3"/>',
  },
  // 我的
  user: {
    vb: '0 0 24 24',
    inner: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  },
  // 精准计数
  target: {
    vb: '0 0 24 24',
    inner:
      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/>',
  },
  // 训练本地存档
  save: {
    vb: '0 0 24 24',
    inner: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/><rect x="9" y="13" width="6" height="5"/>',
  },
  // 多运动支持 / 训练次数 / 默认
  dumbbell: {
    vb: '0 0 24 24',
    inner:
      '<line x1="3" y1="10" x2="3" y2="14"/><line x1="6" y1="8" x2="6" y2="16"/><line x1="9" y1="10.5" x2="15" y2="10.5"/><line x1="9" y1="13.5" x2="15" y2="13.5"/><line x1="18" y1="8" x2="18" y2="16"/><line x1="21" y1="10" x2="21" y2="14"/>',
  },
  // 我的训练档案
  clipboard: {
    vb: '0 0 24 24',
    inner:
      '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="15" y2="15"/>',
  },
  // 成就徽章
  award: {
    vb: '0 0 24 24',
    inner: '<circle cx="12" cy="9" r="5"/><path d="M9 14l-2 7 5-3 5 3-2-7"/>',
  },
  // 会员成长体系
  sprout: {
    vb: '0 0 24 24',
    inner:
      '<path d="M12 20v-7"/><path d="M12 13c0-4-4-5-7-5 0 4 3 5 7 5z"/><path d="M12 11c0-3 4-4 7-4 0 3-3 4-7 4z"/>',
  },
  // 初次训练 / 升级完成（庆祝星光）
  sparkles: {
    vb: '0 0 24 24',
    inner:
      '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z"/>',
  },
  // 百跳成就（奖牌）
  medal: {
    vb: '0 0 24 24',
    inner: '<circle cx="12" cy="14" r="6"/><path d="M9 2l3 6 3-6"/>',
  },
  // 千跳 / 个数（火焰）
  flame: {
    vb: '0 0 24 24',
    inner:
      '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  },
  // 万跳（星）
  star: {
    vb: '0 0 24 24',
    inner: '<path d="M12 2l2.9 6.3 6.6.7-4.9 4.5 1.4 6.5L12 16.9 6 20.5l1.4-6.5L2.5 9l6.6-.7z"/>',
  },
  // 打卡（日历）
  calendar: {
    vb: '0 0 24 24',
    inner:
      '<rect x="4" y="5" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="8" y1="3" x2="8" y2="6"/><line x1="16" y1="3" x2="16" y2="6"/>',
  },
  // 时长 / 时光跑者（时钟）
  clock: {
    vb: '0 0 24 24',
    inner: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  },
  // 勾选
  check: {
    vb: '0 0 24 24',
    inner: '<path d="M5 12l5 5L20 7"/>',
  },
  // 会员权益（皇冠）
  crown: {
    vb: '0 0 24 24',
    inner: '<path d="M4 19V8l4 4 4-7 4 7 4-4v11z"/>',
  },
  // 退出登录
  'log-out': {
    vb: '0 0 24 24',
    inner:
      '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 12H3"/><path d="M7 8l-4 4 4 4"/>',
  },
  // 播放（备用）
  play: {
    vb: '0 0 24 24',
    inner: '<path d="M7 4l13 8-13 8z"/>',
  },
  // 锁（未解锁）
  lock: {
    vb: '0 0 24 24',
    inner: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  },
  // 分享（三节点 + 连线，通用分享语义；用于数据页「生成分享卡片」）
  share: {
    vb: '0 0 24 24',
    inner:
      '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' +
      '<path d="M8.6 13.5l6.8 4"/><path d="M15.4 6.5l-6.8 4"/>',
  },

  // ===== 运动专属（48x48 坐标系） =====
  // 跳绳：小人双手甩绳，绳子从两手下垂绕到脚底形成长弧（清晰表达“甩绳跳动”）
  rope: {
    vb: '0 0 48 48',
    sw: 3,
    inner:
      '<circle cx="24" cy="11" r="3.5"/>' +
      '<path d="M24 14.5 L24 29"/>' +
      '<path d="M24 18 L13 22"/>' +
      '<path d="M24 18 L35 22"/>' +
      '<path d="M13 22 Q5 40 24 44 Q43 40 35 22"/>' +
      '<path d="M24 29 L19 39"/>' +
      '<path d="M24 29 L29 39"/>',
  },
  // 垫排球：球体 + 顶/底各 1 个分叉点 + 中央横线，6 片面板（完全照参考线稿）
  volleyball: {
    vb: '0 0 48 48',
    sw: 2.6,
    inner:
      '<circle cx="24" cy="24" r="17"/>' +
      '<path d="M24 7 Q 14 11 11 22"/>' +
      '<path d="M24 7 Q 34 11 37 22"/>' +
      '<path d="M9 23 Q 24 28 39 23"/>' +
      '<path d="M24 41 Q 14 37 11 26"/>' +
      '<path d="M24 41 Q 34 37 37 26"/>',
  },
};

// 根据名称生成 data URI（color 缺省为品牌色）
function buildSvg(name, color) {
  const it = ICONS[name];
  if (!it) return '';
  const c = color || BRAND;
  const sw = it.sw || 2;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
    it.vb +
    '" fill="none" stroke="' +
    c +
    '" stroke-width="' +
    sw +
    '" stroke-linecap="round" stroke-linejoin="round">' +
    it.inner +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

module.exports = { buildSvg, ICONS, BRAND };
