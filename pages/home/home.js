// pages/home/home.js —— 首页：对齐 docs/档C全应用视觉系统_可交互原型.html 的 pgHome()
const { fmtTime } = require('../../utils/format.js');

Page({
  data: {
    // 自定义导航（navigationStyle: custom）下的顶部留白，onLoad 里按状态栏高度算
    statusBarH: 20,

    // 运动项目：跳绳 / 垫排球（写实照片卡，图在 images/）
    sports: [
      { key: 'rope', name: '跳绳', img: '/images/home-rope.jpg' },
      { key: 'volleyball', name: '垫排球', img: '/images/home-volleyball.jpg' },
    ],
    selectedSport: 'rope',

    // 训练模式（定时 / 定数 / 自由）
    modes: [
      { key: 'timed', name: '定时' },
      { key: 'counted', name: '定数' },
      { key: 'free', name: '自由' },
    ],
    selectedMode: 'timed',

    // 定时
    duration: 60, // 秒
    timeStr: '01:00',

    // 定数
    targetCount: 100,

    // 分组训练 / 休息：作为「定时 / 定数 / 自由」各自下的开关（groupOn），
    // 开启后参数随模式变化 —— 定时=每组时长+休息，定数=每组个数+休息，自由=仅休息。
    // 边界与原型 groupSheet() 的 case 'gadj' 一致：组数 1~10、每组 15~300 秒或 10~1000 个、休息 15~180 秒。
    groupOn: false,
    groupSets: 3,        // 组数 1~10，步长 1
    groupWork: 60,       // 定时：每组时长 15~300 秒；定数：每组个数 10~1000
    groupWorkStr: '01:00',
    groupRest: 30,       // 组间休息 15~180 秒，步长 15
    groupRestStr: '00:30',
  },

  onLoad() {
    this._updateTimeStr();
    this._readStatusBar();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
  },

  // 自定义导航下的状态栏留白（原型里内容紧贴状态栏下方）
  _readStatusBar() {
    let h = 20;
    try {
      const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
      if (info && info.statusBarHeight) h = info.statusBarHeight;
    } catch (e) {
      // 取不到就沿用 20px 保底
    }
    this.setData({ statusBarH: h + 6 });
  },

  // 切换运动
  selectSport(e) {
    this.setData({ selectedSport: e.currentTarget.dataset.key });
  },

  selectMode(e) {
    this.setData({ selectedMode: e.currentTarget.dataset.key });
  },

  // 定时调节（步长 30 秒）
  minusTime() {
    const duration = Math.max(10, this.data.duration - 30);
    this.setData({ duration }, () => this._updateTimeStr());
  },
  addTime() {
    const duration = Math.min(3600, this.data.duration + 30);
    this.setData({ duration }, () => this._updateTimeStr());
  },
  _updateTimeStr() {
    this.setData({ timeStr: fmtTime(this.data.duration) });
  },

  // 定数调节（步长 10 个）
  minusCount() {
    const targetCount = Math.max(10, this.data.targetCount - 10);
    this.setData({ targetCount });
  },
  addCount() {
    const targetCount = Math.min(5000, this.data.targetCount + 10);
    this.setData({ targetCount });
  },

  // —— 分组训练 / 休息：作为当前模式的开关 ——
  // 抽屉体 catchtap 的空处理器：只用于阻止冒泡（点了内容不该关）
  noop() {},

  // 开关：开启/关闭分组训练（参数随当前模式变化）
  toggleGroup() {
    this.setData({ groupOn: !this.data.groupOn });
  },

  // 参数步进。步长写进 data-v：组数 ±1、休息 ±15 秒；
  // 工作段参数随模式不同 —— 定时=秒（±15），定数=个数（±10）。
  onGroupAdj(e) {
    const k = e.currentTarget.dataset.k;
    const v = parseInt(e.currentTarget.dataset.v, 10) || 0;
    const d = this.data;
    if (k === 'sets') {
      this.setData({ groupSets: Math.max(1, Math.min(10, d.groupSets + v)) });
    } else if (k === 'work') {
      if (d.selectedMode === 'counted') {
        const s = Math.max(10, Math.min(1000, d.groupWork + v));
        this.setData({ groupWork: s });        // 定数：每组个数
      } else {
        const s = Math.max(15, Math.min(300, d.groupWork + v));
        this.setData({ groupWork: s, groupWorkStr: fmtTime(s) }); // 定时：每组时长
      }
    } else if (k === 'rest') {
      const s = Math.max(15, Math.min(180, d.groupRest + v));
      this.setData({ groupRest: s, groupRestStr: fmtTime(s) });
    }
  },

  start() {
    const { selectedSport, selectedMode, duration, targetCount, groupOn, groupSets, groupWork, groupRest } = this.data;
    let target = 0;
    if (selectedMode === 'counted') target = targetCount;

    let q = `sport=${selectedSport}&mode=${selectedMode}&duration=${duration}&target=${target}`;
    // 分组：把 sets/work/rest 一并带过去。work 含义随模式（定时=秒 / 定数=个数），
    // 训练页 onLoad 会按 mode 决定每组怎么结束。
    if (groupOn) {
      q += `&group=1&sets=${groupSets}&work=${groupWork}&rest=${groupRest}`;
    }
    wx.navigateTo({ url: '/pages/index/index?' + q });
  },
});
