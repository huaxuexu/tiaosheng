// utils/format.js —— 统一格式化工具（消除 home/data/training/index 四处重复）
function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmtTime(sec) { sec = Math.max(0, sec | 0); return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60); }
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return h + '时' + m + '分';
  if (m > 0) return m + '分' + (s ? pad(s) + '秒' : '');
  return s + '秒';
}
module.exports = { pad, fmtTime, fmtDuration };
