// utils/auth.js —— 微信登录与会员资料管理
//
// 真实小程序流程：wx.login() 拿 code → 发给后端 → 后端用 code 调微信
// auth.code2Session 换取 openid / session_key 并建立服务端会话（session_token）。
// 本项目当前无后端，登录态在本地模拟（本地 openid + 资料缓存），
// 接入后端时只需把 login() 内「本地模拟」段替换为 wx.request 即可。

const OPENID_KEY = 'member_openid';
const PROFILE_KEY = 'member_profile';

// 发起微信登录（返回 Promise<openid>）
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('wx.login 未返回 code'));
          return;
        }

        // ===== 本地模拟会话（接入后端时替换此段） =====
        const openid = 'wx_local_' + res.code;
        wx.setStorageSync(OPENID_KEY, openid);
        if (!wx.getStorageSync(PROFILE_KEY)) {
          wx.setStorageSync(PROFILE_KEY, {
            avatarUrl: '',
            nickname: '微信用户',
            joinTs: Date.now(),
            level: '普通会员',
          });
        }
        // ============================================
        // 登录 = 训练档案建立 / 恢复：把未登录期间写入的缓冲记录并入档案
        // （惰性 require，避免与 records.js 循环初始化；失败不影响登录本身）
        try {
          const records = require('./records.js');
          if (records && records.archiveBuffer) records.archiveBuffer();
        } catch (e) { /* 忽略：缓冲并入失败不阻塞登录 */ }

        resolve(openid);
      },
      fail: (err) => reject(err),
    });
  });
}

function isLogin() {
  return !!wx.getStorageSync(OPENID_KEY);
}

function getProfile() {
  return wx.getStorageSync(PROFILE_KEY) || null;
}

function saveProfile(patch) {
  const current = wx.getStorageSync(PROFILE_KEY) || {};
  const next = Object.assign({}, current, patch);
  wx.setStorageSync(PROFILE_KEY, next);
  return next;
}

function logout() {
  wx.removeStorageSync(OPENID_KEY);
  wx.removeStorageSync(PROFILE_KEY);
}

// 计算加入天数：取最早训练记录时间，无记录则看 joinTs 兜底
function memberDays() {
  // 优先用最早训练记录的时间（训练数据已存在，不依赖用户是否点了"登录"）
  const records = require('./records.js');
  const all = records.getAll();
  if (all.length > 0) {
    const earliest = Math.min(...all.map((r) => r.ts));
    return Math.max(1, Math.floor((Date.now() - earliest) / 86400000) + 1);
  }
  // 兜底：无任何训练记录时看 joinTs
  const p = wx.getStorageSync(PROFILE_KEY) || {};
  const joinTs = p.joinTs || Date.now();
  return Math.max(1, Math.floor((Date.now() - joinTs) / 86400000) + 1);
}

module.exports = { login, isLogin, getProfile, saveProfile, logout, memberDays };
