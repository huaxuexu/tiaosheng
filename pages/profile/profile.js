// pages/profile/profile.js —— 我的：本机档案 + 账号操作
const auth = require('../../utils/auth.js');
const ui = require('../../utils/ui.js');
// 只取「未登录缓冲天数」这一个常量用于文案（本项目要求删除规则对用户明示）。
// 本页不读任何训练数据 —— 统计属「数据」页职责。
const BUFFER_DAYS = require('../../utils/records.js').BUFFER_DAYS;

Page({
  data: {
    statusBarH: 26,
    isLogin: false,
    avatarUrl: '',
    avatarChar: '微',
    nickname: '',
    agreed: false, // 是否勾选同意协议（默认不勾选，不得默认强制同意）
    memberDays: 0,
    bufferDays: BUFFER_DAYS,
  },

  onLoad() {
    this._pageAlive = true;
    // 基于历史同意记录初始化勾选态：老用户显示已同意，新用户必定默认不勾选
    this.setData({ agreed: !!wx.getStorageSync('agreedProtocol'), statusBarH: ui.statusBarH() });
    this.refresh();
  },

  onUnload() {
    this._pageAlive = false;  // 页面卸载标记：防止异步回调里 setData 崩溃
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 });
    }
    // 从其它入口返回时同步最新资料与会员数据
    if (auth.isLogin()) this.refresh();
  },

  refresh() {
    if (!auth.isLogin()) {
      this.setData({ isLogin: false, avatarUrl: '', nickname: '' });
      return;
    }
    const p = auth.getProfile() || {};
    const nickname = p.nickname || '微信用户';
    this.setData({
      isLogin: true,
      avatarUrl: p.avatarUrl || '',
      nickname,
      avatarChar: nickname.slice(0, 1),
      memberDays: auth.memberDays(),
      // 注意：本页不再计算 stats（累计个数 / 训练次数 / 连续天数，属「数据」页职责）、
      // benefitPreview（权益预览，属「成长中心」页职责），也不再算会员等级 tier
      // （2026-09-16 移除）：等级由本地累计个数算出、不影响任何功能，展示它只是复述。
      // 因此 records / member 两个依赖也一并移除，本页只剩「我是谁 + 账号操作」。
    });
  },

  onLogin() {
    // 必须先主动勾选同意协议，不得默认强制同意
    const agreed = this.data.agreed || wx.getStorageSync('agreedProtocol');
    if (!agreed) {
      wx.showToast({ title: '请先阅读并同意《用户协议》与《隐私政策》', icon: 'none' });
      return;
    }
    wx.setStorageSync('agreedProtocol', true);
    wx.showLoading({ title: '登录中...' });
    auth
      .login()
      .then(() => this._fetchWechatProfile()) // 登录后拉取微信头像/昵称
      .then(() => {
        if (!this._pageAlive) return;  // 登录过程中页面可能已被卸载（返回/切 tab）
        this.refresh();
        wx.hideLoading();
        wx.showToast({ title: '登录成功', icon: 'success' });
      })
      .catch(() => {
        if (!this._pageAlive) return;
        wx.hideLoading();
        wx.showToast({ title: '登录失败', icon: 'none' });
      });
  },

  // 拉取微信资料：优先用 getUserProfile 自动获取头像与昵称；
  // 新基础库下该接口可能返回匿名数据（灰头像/“微信用户”），
  // 此时不覆盖，保留「点击头像/昵称」手动填入真实微信资料的入口。
  _fetchWechatProfile() {
    return new Promise((resolve) => {
      const done = () => resolve();
      wx.getUserProfile({
        desc: '用于展示会员头像与昵称',
        success: (res) => {
          const info = (res && res.userInfo) || {};
          const patch = {};
          if (info.avatarUrl) patch.avatarUrl = info.avatarUrl;
          if (info.nickName && info.nickName !== '微信用户') patch.nickname = info.nickName;
          if (Object.keys(patch).length) auth.saveProfile(patch);
          done();
        },
        fail: () => done(), // 用户拒绝或接口不可用：忽略，沿用手动设置
      });
    });
  },

  // 勾选 / 取消勾选协议
  onAgreeTap() {
    this.setData({ agreed: !this.data.agreed });
  },

  // 跳转阅读协议全文（用户协议 / 隐私政策）
  goAgreement(e) {
    const type = e.currentTarget.dataset.type || 'privacy';
    wx.navigateTo({ url: '/pages/agreement/agreement?type=' + type });
  },

  // 微信新昵称/头像接口：button open-type=chooseAvatar 获取头像
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    if (!avatarUrl) return;
    auth.saveProfile({ avatarUrl });
    this.setData({ avatarUrl });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  // input type=nickname 失焦时保存（微信会回填微信昵称）
  onNicknameBlur(e) {
    const nickname = (e.detail.value || '').trim();
    if (!nickname) return;
    auth.saveProfile({ nickname });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      // 退出后历史会「消失」（回到只显示当日的视图），必须在弹窗里说清是视图变化而不是数据丢失，
      // 否则用户会以为档案被删了 —— 这是登录门控方案里最容易翻车的一句话。
      content: '本机档案仍会保留，重新登录即可恢复；退出后只显示当日记录。',
      confirmColor: '#FF4E2A',
      success: (res) => {
        if (res.confirm) {
          auth.logout();
          this.refresh();
        }
      },
    });
  },

  // 逐次训练明细入口（goTraining）与成长中心入口（goMember）已从本页移除：
  // 前者改挂「数据」页（pages/data/data.js 的 goTraining），后者待成长/会员口径定了再挂。
  // 两个目标页本身都还在 app.json 里注册，未删除。
});
