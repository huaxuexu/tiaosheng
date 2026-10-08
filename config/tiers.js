// config/tiers.js —— 统一等级/阈值定义（消除 achievement/member 两处重复）
const LEVELS = [
  { min: 0,     name: '青铜',   color: '#CD7F32', icon: 'medal' },
  { min: 300,   name: '白银',   color: '#C0C0C0', icon: 'medal' },
  { min: 1000,  name: '黄金',   color: '#FFD700', icon: 'medal' },
  { min: 5000,  name: '钻石',   color: '#00BFFF', icon: 'trophy' },
  { min: 20000, name: '王者',   color: '#FF4500', icon: 'crown' },
];
module.exports = { LEVELS };
