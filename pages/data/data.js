// pages/data/data.js —— 运动数据统计（按运动 × 日 / 周 / 月）
const records = require('../../utils/records.js');
const { fmtDuration } = require('../../utils/format.js');
const ui = require('../../utils/ui.js');

const RANGE_CONFIG = {
  day:   { trendN: 7, trendTitle: '近 7 天', periodLabel: '今日累计', prevLabel: '昨日' },
  week:  { trendN: 6, trendTitle: '近 6 周', periodLabel: '本周累计', prevLabel: '上周' },
  month: { trendN: 6, trendTitle: '近 6 月', periodLabel: '本月累计', prevLabel: '上月' },
};

// 各运动维度配置：个数卡片标签 / 趋势标题 / 空态前缀。
// 数据页按运动独立拆分，避免排球记录被算进"跳绳个数"。
const SPORT_CONFIG = {
  rope:       { name: '跳绳' },
  volleyball: { name: '垫排球' },
};

// 空态文案：周期（今日/本周/本月）+ 运动名
function emptyText(range, sport) {
  const period = range === 'day' ? '今日' : range === 'week' ? '本周' : '本月';
  const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.rope;
  return period + '还没有' + cfg.name + '训练记录，去练一组吧';
}

// 上一个同长度周期的累计数（用于「较昨日 / 较上周 / 较上月」）
// ⚠️ 必须走 records.getVisible()：未登录时「昨日 / 上周 / 上月」属时间纵深，一律不可见（返回 0）。
function prevSum(range, sport) {
  const all = records.getVisible();
  const s = records.bucketStart(range, 1);
  const e = records.bucketStart(range, 0);
  let c = 0;
  for (const r of all) {
    if (sport && sport !== 'all' && r.sport !== sport) continue;
    if (r.ts >= s && r.ts < e) c += r.count || 0;
  }
  return c;
}

// 环比文案：日看绝对增量，周 / 月看百分比
function deltaOf(range, cur, prev) {
  if (!cur && !prev) return { deltaText: '', deltaUp: false };
  const diff = cur - prev;
  const up = diff >= 0;
  const sign = up ? '+' : '-';
  if (range === 'day') return { deltaText: '较昨日 ' + sign + Math.abs(diff), deltaUp: up };
  if (!prev) {
    const label = RANGE_CONFIG[range].prevLabel;
    return { deltaText: '较' + label + ' 新增', deltaUp: true };
  }
  const pct = Math.round((Math.abs(diff) / prev) * 100);
  return { deltaText: '较' + RANGE_CONFIG[range].prevLabel + ' ' + sign + pct + '%', deltaUp: up };
}

Page({
  data: {
    statusBarH: 26,
    capsuleRpx: 188,
    monthTag: '9 月',

    isLogin: false,                    // 登录门控：未登录只展示今日
    bufferDays: records.BUFFER_DAYS,   // 未登录时本机暂存天数（文案里要写出来，规则必须明示）

    range: 'day',
    sport: 'rope',                     // 默认展示跳绳（主运动）
    ranges: [
      { key: 'day', name: '日' },
      { key: 'week', name: '周' },
      { key: 'month', name: '月' },
    ],
    sports: [
      { key: 'rope', name: '跳绳' },
      { key: 'volleyball', name: '垫排球' },
    ],

    count: 0,
    metricLabel: '跳绳 · 今日累计',
    deltaText: '',
    deltaUp: false,
    durationStr: '0秒',
    sessions: 0,
    streakDays: 0,

    trend: [],
    trendTitle: '近 7 天',
    mean: 0,
    hiIndex: 0,
    avgBottomRpx: 128,
    emptyText: '今日还没有跳绳训练记录，去练一组吧',
    hasData: false,

    // 分享卡片：shareOpen 控预览面板，shareCardPath 是 canvas 产出图（预览与分享用同一张）
    shareOpen: false,
    shareCardPath: '',
  },

  onLoad() {
    this._pageAlive = true;
    this.setData({
      statusBarH: ui.statusBarH(),
      capsuleRpx: ui.capsuleRpx(),
      monthTag: (new Date().getMonth() + 1) + ' 月',
    });
  },

  onUnload() {
    this._pageAlive = false;
  },

  // 切走 tab 时收起预览面板：回来时不会停在一个「上次留下的浮层」上
  onHide() {
    if (this.data.shareOpen) this.setData({ shareOpen: false });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.reload();
  },

  reload() {
    const { range, sport } = this.data;
    const cfg = RANGE_CONFIG[range];
    const sportCfg = SPORT_CONFIG[sport] || SPORT_CONFIG.rope;
    const isLogin = records.isLoggedIn();
    const agg = records.aggregate(range, sport);
    const trend = records.trend(range, cfg.trendN, sport);
    const hasData = trend.some((b) => b.count > 0);

    // 数据变了，上一张分享卡片就作废（避免把旧数字分享出去）
    if (this._shareCardPath) this._shareCardPath = '';

    // 环比（较昨日 / 上周 / 上月）与「连续天数」都属时间纵深，未登录时一律不展示。
    // 未登录页只回答「今天练了多少」这一个问题，其余靠顶部提示条引导建立档案。
    const delta = isLogin
      ? deltaOf(range, agg.count, prevSum(range, sport))
      : { deltaText: '', deltaUp: false };

    // 趋势图：峰值柱高亮 + 均值虚线（容器 240rpx、柱底 32rpx、柱高 192rpx）
    const counts = trend.map((b) => b.count);
    const max = Math.max(1, ...counts);
    const mean = counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0;
    let hiIndex = 0;
    counts.forEach((c, i) => { if (c > counts[hiIndex]) hiIndex = i; });
    let avgBottomRpx = Math.round(32 + 192 * (1 - Math.min(1, mean / max)));
    avgBottomRpx = Math.max(40, Math.min(216, avgBottomRpx));

    this.setData({
      isLogin,
      count: agg.count,
      metricLabel: sportCfg.name + ' · ' + cfg.periodLabel,
      ...delta,
      durationStr: fmtDuration(agg.durationSec),
      sessions: agg.sessions,
      streakDays: isLogin ? records.streak() : 0,
      trend,
      trendTitle: cfg.trendTitle,
      mean,
      hiIndex,
      avgBottomRpx,
      emptyText: emptyText(range, sport),
      hasData,
      shareCardPath: '',
    });
  },

  switchRange(e) {
    const range = e.currentTarget.dataset.key;
    if (range === this.data.range) return;
    this.setData({ range }, () => this.reload());
  },

  switchSport(e) {
    const sport = e.currentTarget.dataset.key;
    if (sport === this.data.sport) return;
    this.setData({ sport }, () => this.reload());
  },

  // 跳转逐次明细页（原挂在「我的」页，2026-09-16 移入数据页）
  goTraining() {
    wx.navigateTo({ url: '/pages/training/training' });
  },

  // 未登录提示条的「建立档案」：切到「我的」tab 走登录引导
  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  /* ==================== 分享卡片 ====================
     口径「所见即所分享」：卡片按当前页面的可见数据绘制，未登录时就是今日的数。
     预览面板里显示的就是最终要分享的那张图（同一个 canvas 产物），不是另画的 DOM 版。 */

  openShare() {
    if (this.data.shareOpen) return;
    this.setData({ shareOpen: true, shareCardPath: '' });
    this._drawShareCard();
  },

  closeShare() {
    if (!this.data.shareOpen) return;
    this.setData({ shareOpen: false });
  },

  // 面板本体吞掉点击：否则点卡片内部会被 .overlay 的 bindtap 关掉面板
  noop() {},

  _sharePath() {
    return this._shareCardPath || this.data.shareCardPath || '';
  },

  _drawShareCard() {
    const query = wx.createSelectorQuery();
    query.select('#shareCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!this._pageAlive) return;  // 页面可能在 canvas 查询期间被卸载
        if (!res || !res[0] || !res[0].node) {
          console.warn('[share] canvas not ready');
          if (this.data.shareOpen) wx.showToast({ title: '卡片生成失败，请重试', icon: 'none' });
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        // 版式复刻原型 dataShareSheet() 的卡片：全幅品牌橙**纯色** + 品牌名 / 周期名 / 大数字
        // / 分隔线 / 统计格 / 页脚。原型卡片 DOM 实测 319×226，这里 2× 绘制 ——
        // 本函数里坐标与字号除以 2 即可与原型实测值逐项对照（tools/_probe_sharecard.js）。
        // 不画装饰圈与底部短线：原型那张卡没有，分享图不该比设计稿多出元素。
        // 底色**不用渐变**：原先是 linear-gradient(135deg,#FF4E2A,#FF6B35 50%,#ff8c00)，
        // 与训练结果页那张卡的纯色 #FF4E2A 橙头不一致；两张分享卡现在共用同一个品牌橙。
        const K = 2;
        const W = 319 * K, H = 226 * K;
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);

        const d = this.data;
        // 日期文案与原型页脚同格式：9月16日 周三。
        // （toLocaleDateString('zh-CN') 会输出「9/16周三」，与设计稿对不上。）
        const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const now = new Date();
        const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
        // 连续天数属时间纵深：未登录时页面上是 0，印到对外可见的卡片上等于断言「没连续练过」，
        // 与门控「不展示跨天累计」同一条原则 —— 干脆不画那一格，而不是画个 0。
        const stats = [
          ['训练时长', d.durationStr],
          ['训练次数', String(d.sessions) + ' 次'],
        ];
        if (d.isLogin) stats.push(['连续天数', String(d.streakDays) + ' 天']);

        // 1) 品牌橙纯色底（原型的品牌色；与训练结果页卡的橙头同色，两张分享卡共用一个品牌橙）
        ctx.fillStyle = '#FF4E2A';   // = app.wxss --brand
        ctx.fillRect(0, 0, W, H);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 2) 品牌名 + 周期名
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.font = `bold ${13 * K}px sans-serif`;
        ctx.fillText('会有时计数器', W / 2, 24 * K);
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.font = `${11 * K}px sans-serif`;
        ctx.fillText(d.metricLabel, W / 2, 46 * K);

        // 3) 核心数字：连同「个」整体居中（先量宽再定起点，不靠字数估算）
        const numStr = String(d.count);
        ctx.font = `bold ${52 * K}px sans-serif`;
        const nw = ctx.measureText(numStr).width;
        ctx.font = `${12 * K}px sans-serif`;
        const uw = ctx.measureText('个').width;
        const gap = 3.25 * K;   // 原型里数字与「个」之间是一个 &nbsp;
        const sx = (W - (nw + gap + uw)) / 2;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${52 * K}px sans-serif`;
        ctx.fillText(numStr, sx, 91.5 * K);
        ctx.fillStyle = 'rgba(255,255,255,0.62)';
        ctx.font = `${12 * K}px sans-serif`;
        ctx.fillText('个', sx + nw + gap, 105.5 * K);

        // 4) 分隔线（原型左右各留 24px）
        ctx.beginPath();
        ctx.moveTo(24 * K, 132 * K);
        ctx.lineTo(W - 24 * K, 132 * K);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 5) 统计格（值在上、标签在下；格数与统计项一致：登录 3 格 / 未登录 2 格）
        const cellW = W / stats.length;
        stats.forEach((s, i) => {
          const cx = cellW * (i + 0.5);
          ctx.textAlign = 'center';
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${17 * K}px sans-serif`;
          ctx.fillText(s[1], cx, 158 * K);
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.font = `${9 * K}px sans-serif`;
          ctx.fillText(s[0], cx, 180.5 * K);
        });

        // 6) 页脚
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `${9 * K}px sans-serif`;
        ctx.fillText(dateStr + '  ·  微信小程序「会有时计数器」', W / 2, 207.5 * K);

        // 8) 导出为临时文件（预览面板与分享/保存共用这一张）
        // ★ destWidth/destHeight 必须按**设备像素**给，不能给逻辑单位。
        //   W/H 是「设计坐标的 2×」逻辑单位（638×452），而画布的物理分辨率是 W*dpr
        //   （dpr=3 时 1914×1356）。原先写成 destWidth: W，等于把 1914×1356 的画面
        //   压成 638×452；而预览面板/朋友圈按 ~1000+ 设备像素展示，等于被放大 1.5 倍以上
        //   → 字全发虚。模拟器 dpr=2 时导出图恰好接近显示尺寸，所以「截图清晰、手机发虚」。
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: W, height: H,
          // 截取区域用逻辑单位（= canvas 的绘制坐标系），输出尺寸取**画布物理分辨率**
          // （canvas.width 就是上面设的 W*dpr），两边 1:1 不重采样。
          destWidth: canvas.width, destHeight: canvas.height,
          // 纯色底 + 白字用 PNG：无损，不会像 jpg 那样在笔画边缘留下色度抽样与振铃，
          // 字号越小越明显。这种平色图 PNG 反而比 jpg 更小（实测 1914×1356 约 130 KB）。
          fileType: 'png',
          success: (r) => {
            if (!this._pageAlive) return;
            this._shareCardPath = r.tempFilePath;
            this.setData({ shareCardPath: r.tempFilePath });
          },
          fail: (err) => {
            console.error('[share] canvasToTempFilePath failed:', err);
            if (this._pageAlive && this.data.shareOpen) {
              wx.showToast({ title: '卡片生成失败，请重试', icon: 'none' });
            }
          },
        });
      });
  },

  saveShareCard() {
    const p = this._sharePath();
    if (!p) { wx.showToast({ title: '卡片还在生成，请稍候', icon: 'none' }); return; }
    wx.saveImageToPhotosAlbum({
      filePath: p,
      success: () => {
        if (!this._pageAlive) return;
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        if (!this._pageAlive) return;
        const msg = (err && err.errMsg) || '';
        if (/deny|denied|authorize/i.test(msg)) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存分享卡片需要「保存到相册」权限，去设置里打开？',
            confirmText: '去设置',
            success: (r) => { if (r.confirm && wx.openSetting) wx.openSetting({}); },
          });
        } else if (!/cancel/i.test(msg)) {
          wx.showToast({ title: '保存失败，请重试', icon: 'none' });
        }
      },
    });
  },

  // 截图分享：生成卡片后，弹出微信原生「分享图片」菜单（含朋友圈入口）
  // 菜单自带：发送给朋友 / 分享到朋友圈 / 收藏 / 保存图片 / 转发为贴图
  // needShowEntrance 会在图上嵌入小程序入口，好友/朋友圈点入口即可进入小程序。
  shareByImage() {
    const p = this._sharePath();
    if (!p) { wx.showToast({ title: '卡片还在生成，请稍候', icon: 'none' }); return; }
    // wx.showShareImageMenu 基础库 2.13.0+：弹起微信原生分享图片菜单（含朋友圈入口）
    if (typeof wx.showShareImageMenu === 'function') {
      wx.showShareImageMenu({
        path: p,
        needShowEntrance: true,
        entrancePath: 'pages/home/home',
        fail: (err) => {
          console.warn('[share] showShareImageMenu failed:', err);
          wx.showToast({ title: '当前版本不支持该分享方式', icon: 'none' });
        },
      });
    } else {
      wx.showToast({ title: '当前版本不支持该分享方式', icon: 'none' });
    }
  },

  // 右上角 ··· 菜单：与面板按钮走同一张卡片，口径一致
  onShareAppMessage() {
    const card = this._sharePath();
    const title = this.data.metricLabel + ' ' + this.data.count + ' 个｜会有时计数器';
    if (card) return { title, path: '/pages/home/home', imageUrl: card };
    const that = this;
    return {
      title,
      path: '/pages/home/home',
      imageUrl: '',
      promise: new Promise((resolve) => {
        that._drawShareCard();
        setTimeout(() => resolve({
          title,
          path: '/pages/home/home',
          imageUrl: that._sharePath(),
        }), 900);
      }),
    };
  },

  onShareTimeline() {
    return {
      title: this.data.metricLabel + ' ' + this.data.count + ' 个｜会有时计数器',
      query: '',
      imageUrl: this._sharePath(),
    };
  },
});
