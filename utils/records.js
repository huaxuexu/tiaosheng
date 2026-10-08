// utils/records.js —— 训练记录存储与按 日 / 周 / 月 聚合
//
// 当前为本地存储（无后端）。接入后端时把 saveRecord / getAll 换成 wx.request
// 读写服务端即可，页面与聚合逻辑无需改动。
// 记录结构：{ ts(开始时间戳ms), sport('rope'|'volleyball'), mode, count(完成数), durationSec(训练秒数), arch(0|1) }
//
// ===== 登录门控（2026-09-16 落地）=====
// 产品模型：登录 = 完整历史；未登录 = 只展示「今日」，但本机缓冲保留最近 BUFFER_DAYS 天。
//   · 展示严格、存储宽容 —— 未登录看得少，但数据不会因为「还没建档」就立刻丢。
//   · 规则对用户明示（数据页提示条 / 「我的」页引导），不做隐藏式门槛。
//   · arch 字段区分「档案」与「缓冲」：
//       arch === 0 → 未登录期间写入，属缓冲，超过 BUFFER_DAYS 天会被清理；
//       其余（含登录前就存在的历史遗留记录）→ 视为档案，永不清除（退出登录也不删）。
//   · 登录后写入会把缓冲整体升格为档案（自愈，见 saveRecord / archiveBuffer）。
//
// ⚠️ 两条铁律：
//   1. 绝不能在 getAll() 里做可见性过滤！saveRecord 是「读—改—写」
//      （getAll() → push → setStorageSync），过滤后第一次保存就会把历史整段覆盖掉（静默数据丢失）。
//      可见性只由 getVisible() 承担，getAll() 永远是原始读。
//   2. 面向页面的只读统计一律走 getVisible()，不允许页面直接拿 getAll() 自己过滤
//      （data.js 的 prevSum 曾是例外，已一并改掉）。

const REC_KEY = 'workout_records';
const BUFFER_DAYS = 7;   // 未登录时的本地缓冲天数
const DAY_MS = 86400000;
let _cache = null;       // 内存缓存，避免每次轮询都读盘

// ---- 原始读：写路径 / 缓冲清理 / 迁移判断用。不含任何可见性过滤 ----
function getAll() {
  if (_cache) return _cache;
  _cache = wx.getStorageSync(REC_KEY) || [];
  return _cache;
}

// ---- 登录态：惰性 require，避免与 auth.js 循环初始化
//      （auth.js 的 memberDays() 会 require 本模块；模块顶部互相 require 会拿到半成品）
function isLoggedIn() {
  try {
    const auth = require('./auth.js');
    return !!(auth && typeof auth.isLogin === 'function' && auth.isLogin());
  } catch (e) {
    return false;   // auth 不可用时按最严口径：当作未登录
  }
}

// 今日 00:00 的时间戳
function _todayStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---- 可见读：登录 = 全量；未登录 = 仅今日 ----
// 所有面向页面的只读统计（aggregate / trend / total / totalBySport / bestCount / hasSport / streak）都走这里。
function getVisible() {
  const all = getAll();
  if (isLoggedIn()) return all;
  const s = _todayStart();
  return all.filter((r) => r.ts >= s);
}

// ---- 缓冲清理：只清「未登录期间写入且已超期」的记录，档案一条不动 ----
function _pruneBuffer(list) {
  const cutoff = Date.now() - BUFFER_DAYS * DAY_MS;
  return list.filter((r) => !(r.arch === 0 && r.ts < cutoff));
}

// 把缓冲记录升格为档案：登录成功时调用（saveRecord 里也会自愈式触发）。
// 返回升格后的总条数。
function archiveBuffer() {
  const all = getAll();
  if (!all.some((r) => r.arch === 0)) return all.length;
  const next = all.map((r) => (r.arch === 0 ? Object.assign({}, r, { arch: 1 }) : r));
  wx.setStorageSync(REC_KEY, next);
  _cache = next;
  return next.length;
}

// 保存一条训练记录（返回累计条数）
function saveRecord(rec) {
  const logged = isLoggedIn();
  let list = getAll();
  if (logged) {
    // 登录状态下：未登录期的缓冲并入档案（本次记录也直接进档案）
    if (list.some((r) => r.arch === 0)) {
      list = list.map((r) => (r.arch === 0 ? Object.assign({}, r, { arch: 1 }) : r));
    }
  } else {
    // 未登录状态下：先清掉超期缓冲，本次记录标记为缓冲
    list = _pruneBuffer(list);
  }
  list.push({
    ts: rec.ts || Date.now(),
    sport: rec.sport || 'rope',
    mode: rec.mode || 'free',
    count: rec.count || 0,
    durationSec: rec.durationSec || 0,
    arch: logged ? 1 : 0,
  });
  wx.setStorageSync(REC_KEY, list);
  _cache = list; // 刷新缓存
  return list.length;
}

function clear() {
  wx.removeStorageSync(REC_KEY);
  _cache = null;
}

// 取某 bucket 起点时间戳。offsetBack=0 表示当前（今天/本周一/本月1号）
function bucketStart(range, offsetBack) {
  const d = new Date();
  if (range === 'day') {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - offsetBack);
    return t.getTime();
  }
  if (range === 'week') {
    const day = d.getDay();                 // 0=周日 .. 6=周六
    const diff = day === 0 ? -6 : 1 - day; // 回退到本周一
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
    mon.setDate(mon.getDate() - offsetBack * 7);
    return mon.getTime();
  }
  // month
  return new Date(d.getFullYear(), d.getMonth() - offsetBack, 1).getTime();
}

// bucket 标签文字
function bucketLabel(range, startTs) {
  const d = new Date(startTs);
  if (range === 'day') return (d.getMonth() + 1) + '/' + d.getDate();
  if (range === 'week') return (d.getMonth() + 1) + '/' + d.getDate();
  return (d.getMonth() + 1) + '月';
}

// 聚合某范围（day/week/month）三大指标。
// sport 省略 / 'all' 时统算全部运动；传入具体运动（'rope'|'volleyball'）只统计该运动记录。
function aggregate(range, sport) {
  const all = getVisible();
  const start = bucketStart(range, 0);
  const now = Date.now();
  let count = 0, durationSec = 0, sessions = 0;
  for (const r of all) {
    if (sport && sport !== 'all' && r.sport !== sport) continue;
    if (r.ts >= start && r.ts <= now) {
      count += r.count || 0;
      durationSec += r.durationSec || 0;
      sessions += 1;
    }
  }
  return { count, durationSec, sessions };
}

// 趋势：最近 n 个 bucket，返回 [{ label, count, height(0~100) }]。
// sport 省略 / 'all' 时统算全部运动；传入具体运动只统计该运动记录。
function trend(range, n, sport) {
  const all = getVisible();
  const now = Date.now();
  const buckets = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = bucketStart(range, i);
    const e = i === 0 ? now : bucketStart(range, i - 1);
    let c = 0;
    for (const r of all) {
      if (sport && sport !== 'all' && r.sport !== sport) continue;
      if (r.ts >= s && r.ts < e) c += r.count || 0;
    }
    buckets.push({ start: s, label: bucketLabel(range, s), count: c });
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return buckets.map((b) => ({
    label: b.label,
    count: b.count,
    height: b.count > 0 ? Math.max(6, Math.round((b.count / max) * 100)) : 2,
  }));
}

// 全部时间聚合（不限范围），供挑战/成就页做累计统计
function total() {
  const all = getVisible();
  let count = 0, durationSec = 0, sessions = 0;
  for (const r of all) {
    count += r.count || 0;
    durationSec += r.durationSec || 0;
    sessions += 1;
  }
  return { count, durationSec, sessions };
}

// 指定运动的全部时间聚合
function totalBySport(sport) {
  const all = getVisible();
  let count = 0, durationSec = 0, sessions = 0;
  for (const r of all) {
    if (r.sport !== sport) continue;
    count += r.count || 0;
    durationSec += r.durationSec || 0;
    sessions += 1;
  }
  return { count, durationSec, sessions };
}

// 单条记录最大完成数（用于"百跳"等挑战）
function bestCount() {
  const all = getVisible();
  let best = 0;
  for (const r of all) if ((r.count || 0) > best) best = r.count;
  return best;
}

// 是否存在某运动的训练记录
function hasSport(sport) {
  return getVisible().some((r) => r.sport === sport);
}

// 当前连续打卡天数：连续有训练记录的天数，结尾须为今天或昨天，间隔 >1 天即断
function streak() {
  const all = getVisible();
  if (!all.length) return 0;
  const daySet = {};
  for (const r of all) {
    const d = new Date(r.ts);
    daySet[d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()] = true;
  }
  const days = Object.keys(daySet)
    .map((k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); })
    .sort((a, b) => a - b);

  const today = new Date();
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const last = days[days.length - 1];
  // 最新训练既非今天也非昨天 → 连续已断
  if (!sameDay(last, today) && !sameDay(last, yest)) return 0;

  let s = 1;
  for (let i = days.length - 2; i >= 0; i--) {
    const diff = Math.round((days[i + 1] - days[i]) / 86400000);
    if (diff === 1) s++;
    else break;
  }
  return s;
}

module.exports = {
  getAll, getVisible, saveRecord, clear, archiveBuffer, isLoggedIn, BUFFER_DAYS,
  aggregate, trend, bucketStart, bucketLabel,
  total, totalBySport, bestCount, hasSport, streak,
};
