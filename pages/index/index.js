// pages/index/index.js —— 通用训练页（微信 VisionKit 原生身体追踪）
//
// 支持：运动（rope 跳绳 / volleyball 垫排球）× 模式（timed 定时 / counted 定数 / free 自由）。
// 语音倒计时（女声，见 utils/voice.js）：
//   · 开始计数前：三种模式统一 5 秒倒计时（5..1 + “开始”，见 PREP_SECONDS）
//   · 训练中每满 10 跳：报当前总数（10/20/30…）—— 策略C
//   · 定时结束前 10 秒：10..1 + “时间到”（此期间静音里程碑）
//   · 定数接近目标前 10 个：10..1 + “完成”（此期间静音里程碑）
// 计数仅更新数据，无震动反馈。
//
// 为什么用 VisionKit 而不是 tfjs+MoveNet：端侧直接吐人体 2D 关键点（23 点），
// 不下载模型、不走网络、无需自有备案域名。代价：需基础库 2.28.0+ 与支持设备。
//
// ⚠️ 23 点“索引→部位”官方只给图示没给表。BODY_IDX 为常用引用顺序，请用
// 「调试关节点」浮层在真机核对（跳绳：髋部点应随起跳明显上移）。核对后只改
// BODY_IDX 即可，无需动其它逻辑。
const SkippingCounter = require('./SkippingCounter.js');
const VolleyCounter = require('./VolleyCounter.js');
const voice = require('../../utils/voice.js');
const records = require('../../utils/records.js');
const { fmtTime } = require('../../utils/format.js');

// 微信 VisionKit 人体 2D 关键点索引（23 点）。
// 本映射经真机调试浮层标定：髋部对应索引 11、12，其余按此锚点推导。
// 若换设备/基础库后计数异常，请重新用「调试关节点」浮层核对并只改下方 BODY_IDX。
const BODY_IDX = {
  NOSE: 0,
  L_SHOULDER: 5,  R_SHOULDER: 6,
  L_ELBOW: 7,     R_ELBOW: 8,
  L_WRIST: 9,     R_WRIST: 10,
  L_HIP: 11,      R_HIP: 12,
  L_KNEE: 13,     R_KNEE: 14,
  L_ANKLE: 15,    R_ANKLE: 16,
};

// —— 路线A：BODY_IDX 只读对照校验（不改计数逻辑，仅供调试浮层判定）——
// 官方 23 点顺序只有图示、无文本表，社区存在两种互斥流派：
//   流派①「区域分组」：鼻0 颈1 肩2/3 髋4/5 肘6/7 腕8/9 膝10/11 踝12/13
//   流派②「肢体顺序」：鼻0 颈1 肩2/3 肘4/5 腕6/7 髋8/9 膝10/11 踝12/13（MediaPipe 风格）
// 直立人体必满足解剖序：肩.y < 髋.y < 膝.y < 踝.y（y 向下为增），且左.x < 右.x。
// 下方仅做「哪种流派与当前帧匹配」的判定，用于在浮层提示真实布局；
// 绝不修改 BODY_IDX，避免运行时自校正引入不确定性（用户已要求固定映射）。
const LAYOUT_CANDIDATES = [
  { name: '①区域', NOSE: 0, L_SHOULDER: 2, R_SHOULDER: 3, L_HIP: 4,  R_HIP: 5,  L_ELBOW: 6, R_ELBOW: 7, L_WRIST: 8,  R_WRIST: 9,  L_KNEE: 10, R_KNEE: 11, L_ANKLE: 12, R_ANKLE: 13 },
  { name: '②肢体', NOSE: 0, L_SHOULDER: 2, R_SHOULDER: 3, L_ELBOW: 4, R_ELBOW: 5, L_WRIST: 6, R_WRIST: 7, L_HIP: 8,    R_HIP: 9,    L_KNEE: 10, R_KNEE: 11, L_ANKLE: 12, R_ANKLE: 13 },
];
function _layoutMatches(points, L) {
  const g = (i) => (points && points[i] && points[i].x != null && points[i].y != null) ? points[i] : null;
  const shL = g(L.L_SHOULDER), shR = g(L.R_SHOULDER);
  const hipL = g(L.L_HIP), hipR = g(L.R_HIP);
  const kneL = g(L.L_KNEE), kneR = g(L.R_KNEE);
  const ankL = g(L.L_ANKLE), ankR = g(L.R_ANKLE);
  if (!(shL && shR && hipL && hipR && kneL && kneR && ankL && ankR)) return false;
  const sy = (shL.y + shR.y) / 2, hy = (hipL.y + hipR.y) / 2;
  const ky = (kneL.y + kneR.y) / 2, ay = (ankL.y + ankR.y) / 2;
  // 竖直解剖序（含最小间距）
  if (!(sy + 0.04 < hy && hy + 0.04 < ky && ky + 0.03 < ay)) return false;
  // 左右 X 归属：每对左右点必须 左.x < 右.x
  if (!(shL.x < shR.x && hipL.x < hipR.x && ankL.x < ankR.x && kneL.x < kneR.x)) return false;
  // 肩→髋间距须落在"肩→踝"全长的 35%~72%（排除把肘/腕当髋，或把膝当髋）
  const sh2hip = hy - sy, sh2ank = ay - sy;
  if (!(sh2hip > sh2ank * 0.35 && sh2hip < sh2ank * 0.72)) return false;
  // 髋到踝应比髋到膝更远
  if (!((ay - hy) > (ky - hy))) return false;
  return true;
}

// 取景框规则：四角 L 型框定义的「有效计数区」+ 尺度校准（详见历史日志）。
// ⚠️ 修复：原 yMax=0.80 在跳起时易切断特征流 → 放宽至 0.88，并加 grace 保护（连续 3 帧出框才停）
const ROI = { xMin: 0.10, xMax: 0.90, yMin: 0.05, yMax: 0.88 };
const FRAME_H = ROI.yMax - ROI.yMin;
const BODY_RATIO = 0.522;
const CALIB = FRAME_H * BODY_RATIO;
const OUTFRAME_GRACE = 3; // 连续出框帧数阈值，< 此数保留输入，防止跳起时单帧误判

// 开始计数前的统一倒计时秒数（三种模式一致：定时/定数/自由）。
// 语音用已有的 count_5..count_1 + start，无需新增音频。
const PREP_SECONDS = 5;

function pick(points, i) {
  const p = points && points[i];
  if (!p || p.x == null || p.y == null) return null;
  return p;
}

Page({
  data: {
    sport: 'rope',
    mode: 'timed',
    duration: 60,
    target: 100,

    phase: 'prep',      // prep(统一 5 秒准备倒计时) | running | finished
    isRunning: false,   // 是否正在计时/计数（暂停时为 false）
    isPaused: false,

    prepNum: 5,         // 准备倒计时数字（统一 5 秒）
    prepText: '准备',
    prepBeat: false,    // 倒计时数字弹跳动画的触发类开关

    timeStr: '01:00',   // 定时：剩余 MM:SS
    totalSeconds: 60,
    counter: 0,         // 当前完成数
    targetNum: 100,     // 定数目标
    elapsed: 0,         // 已用秒数（自由/定数/结果用）
    elapsedStr: '00:00',

    status: 'DOWN',
    statusText: '准备中…',
    fps: 0,
    poseState: 'init',
    inFrame: true,
    needAuth: false,   // 摄像头未授权时显示引导层

    // 调试
    showDebug: false,
    debugPoints: [],
    sensitivity: 5,
    minVotes: 1,
    dbgHip: 0, dbgAnk: 0, dbgKnee: 0, dbgWrist: 0, dbgFoot: 0, dbgShoulder: 0, dbgStd: 0, dbgVotes: 0, dbgWeight: 0,
    dbgElbow: 0, dbgStdW: 0,
    dbgGateAgree: 0, dbgGateNeed: 0, dbgRejected: 0, dbgArmSig: 0, dbgFootSig: 0, dbgAccelSig: 0, dbgRopeSig: 0,
    vkPointsLen: 0, vkMissingIdx: '',
    mapOk: null, mapHint: '映射自检待采集', candHint: '',
    countBeat: false,   // 计数“暴击”动画开关：计数 +1 时置 true，220ms 后复位

    // 对焦
    showFocus: false,
    focusX: 0,
    focusY: 0,

    // 结果
    resultCount: 0,
    resultElapsed: 0,
    resultElapsedStr: '00:00',

    // 分组训练 / 休息（isGroup，叠加在模式之上）
    //   状态机：准备 → 工作组 ⇄ 组间休息 →（第 N 组结束）→ 结算
    //   语义约定（已与产品确认）：
    //     · 完成个数 = 全程累计总数（counter 从不清零，天然就是总个数）
    //     · 第 N 组结束**不加尾休**，直接结算
    //     · 用时 = 净训练时长（只有工作组累计，休息段不计）
    //   每组结束条件随模式：timed=计时 / counted=达数 / free=手动「结束本组」
    groupSets: 3,         // 总组数 N
    groupWork: 60,        // 定时：每组时长（秒）；定数：每组个数
    groupRest: 30,        // 组间休息（秒）
    groupNo: 1,           // 当前第几组 k（1..N）
    groupPhase: '',       // 'work' | 'rest'
    groupRunning: false,  // 分组会话时钟是否在走（休息段 isRunning=false 但它仍为 true → 供暂停按钮判据）
    groupResting: false,  // 是否正在组间休息（用于抑制出框提示 / 角标变红）
    groupRestNum: 0,      // 休息剩余秒数
    groupRestStr: '00:00',
    groupSetCount: 0,     // 定数分组：当前组内已完成个数（= 总数 − 本组起点）
    groupSetTarget: 0,    // 定数分组：本组目标个数

    // 分享
    shareCardPath: '',   // canvas 导出的临时图片路径
    shareTitle: '',      // 分享标题
  },

  onLoad(options) {
    const sport = options.sport === 'volleyball' ? 'volleyball' : 'rope';
    // mode 是白名单制：只可能是 timed / counted / free，漏登记会被静默降级成 timed。
    // 分组是叠加在模式之上的「开关」(isGroup)，不再作为第 4 种 mode。
    const mode = ['timed', 'counted', 'free'].indexOf(options.mode) >= 0 ? options.mode : 'timed';
    const isGroup = options.group === '1';
    const target = parseInt(options.target, 10) || 100;

    // 分组参数兜底：URL 参数一律夹到与首页相同的边界内，避免手改链接进入非法配置。
    // work 含义随模式不同：定时=秒(15~300)，定数=个数(10~1000)，自由不用。
    const clampInt = (v, lo, hi, dft) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? dft : Math.max(lo, Math.min(hi, n));
    };
    const gWorkLo = mode === 'counted' ? 10 : 15;
    const gWorkHi = mode === 'counted' ? 1000 : 300;
    const gWorkDft = mode === 'counted' ? 100 : 60;
    const groupSets = clampInt(options.sets, 1, 10, 3);
    const groupWork = clampInt(options.work, gWorkLo, gWorkHi, gWorkDft);
    const groupRest = clampInt(options.rest, 15, 180, 30);
    // duration：非分组直接用传入值；分组时借用——定时=每组时长，定数=占位(每组个数在 tick 里覆盖显示)，自由=0。
    let duration;
    if (isGroup && mode === 'timed') duration = groupWork;
    else if (isGroup) duration = mode === 'counted' ? groupWork : 0;
    else duration = parseInt(options.duration, 10) || 60;

    this.setData({
      sport, mode, isGroup, duration, target,
      totalSeconds: duration,
      timeStr: fmtTime(duration),
      targetNum: target,
      groupSets, groupWork, groupRest,
      groupRestStr: fmtTime(groupRest),
      phase: 'prep',          // 四种模式统一：进入页面即走 5 秒准备倒计时
      statusText: '准备中…',
    });
  },

  onReady() {
    this.counter = this.data.sport === 'volleyball' ? new VolleyCounter() : new SkippingCounter();
    // 防御式调用：两个计数器接口不完全一致，缺方法时直接抛错会中断 onReady → 相机永不初始化（黑屏假死）
    const call = (fn, ...args) => {
      if (this.counter && typeof this.counter[fn] === 'function') {
        try { this.counter[fn](...args); } catch (e) { console.error('[counter]', fn, e && e.message); }
      }
    };
    call('setSensitivity', this.data.sensitivity);
    call('setMinVotes', this.data.sport === 'volleyball' ? 3 : this.data.minVotes);
    call('setMinPeriod', 250);
    this._fps = 0;
    this._lastTs = Date.now();
    this._lastFpsPush = 0;
    this._lastDbgPush = 0;
    this._renderFail = 0;
    this._inFrame = true;
    this._doneSpoken = false;
    this._lastRemain = null;
    this._pageAlive = true;   // 页面存活标志：卸载/隐藏后禁止再碰 GL / VKSession
    this._ropeUnsupported = true;   // 绳信号默认关闭：getCameraBuffer 每次分配像素 buffer 有 GC/OOM 开销，故默认走髋单信号
    this._checkAndInit();
  },

  // 主动检查并请求摄像头权限（避免无声黑屏：未授权时 VisionKit 起不来也吞异常）
  _checkAndInit() {
    this.ensureCameraAuth().then((ok) => {
      // 权限弹窗可能持续数秒，期间用户可返回上一页 → 页面卸载后 setData 会崩溃
      if (!this._pageAlive) return;
      if (ok) {
        this._afterCamGranted();
      } else {
        // 未授权 / 被拒：显示引导层，不初始化相机，避免黑屏假死
        this.setData({ needAuth: true, statusText: '需要摄像头权限' });
      }
    });
  },

  // 微信隐私协议授权（隐私新规：调用摄像头等隐私接口前必须先取得用户同意）
  requirePrivacyAuth() {
    return new Promise((resolve) => {
      if (typeof wx.requirePrivacyAuthorize !== 'function') return resolve(true); // 基础库不支持，跳过
      wx.getPrivacySetting({
        success: (res) => {
          if (res.needAuthorization) {
            wx.requirePrivacyAuthorize({
              success: () => resolve(true),
              fail: () => resolve(false), // 用户拒绝隐私协议
            });
          } else {
            resolve(true); // 已在隐私后台配置且用户已同意过
          }
        },
        fail: () => resolve(true),
      });
    });
  },

  // 检查摄像头授权：先确认隐私协议 → 再申请摄像头权限
  ensureCameraAuth() {
    return this.requirePrivacyAuth().then((privacyOk) => {
      if (!privacyOk) return false; // 用户拒绝隐私协议，无法使用相机
      return new Promise((resolve) => {
        wx.getSetting({
          success: (res) => {
            const auth = res.authSetting['scope.camera'];
            if (auth === true) return resolve(true);
            if (auth === false) return resolve(false); // 曾拒绝，不再自动弹窗
            wx.authorize({
              scope: 'scope.camera',
              success: () => resolve(true),
              fail: () => resolve(false),
            });
          },
          fail: () => resolve(true), // 读取设置失败，交给 VisionKit 自身兜底
        });
      });
    });
  },

  // 授权成功后的统一收尾（三种模式一致：进入 5 秒准备倒计时）
  _afterCamGranted() {
    if (!this._pageAlive) return;  // 页面已卸载：静默返回，让 onShow 负责重初始化
    this.setData({ needAuth: false });
    this.initVK();
    if (this.data.phase === 'prep') this._startPrep();
  },

  // 用户点击「去开启权限」：重新请求隐私协议 + 摄像头授权（含系统设置兜底）
  retryAuth() {
    voice.unlock(); // 在用户手势内预解锁音频，保证后续倒计时语音出声
    this.requirePrivacyAuth().then((privacyOk) => {
      if (!this._pageAlive) return;   // 隐私弹窗/设置页期间页面可能已卸载
      if (!privacyOk) {
        wx.showToast({ title: '需先同意隐私协议', icon: 'none' });
        return;
      }
      wx.getSetting({
        success: (res) => {
          if (!this._pageAlive) return; // wx.getSetting 也是异步回调
          if (res.authSetting['scope.camera'] === true) {
            this._afterCamGranted();
            return;
          }
          wx.authorize({
            scope: 'scope.camera',
            success: () => { if (this._pageAlive) this._afterCamGranted(); },
            fail: () => {
              if (!this._pageAlive) return;
              wx.showModal({
                title: '开启摄像头',
                content: '实时计数需要摄像头权限，请在设置中开启',
                confirmText: '去设置',
                success: (m) => { if (m.confirm && this._pageAlive) this.goSetting(); },
              });
            },
          });
        },
      });
    });
  },

  // 引导用户去系统设置开启摄像头权限（需用户手动点击触发）
  goSetting() {
    wx.openSetting({
      success: (res) => {
        // openSetting 打开系统设置页 → onHide 已把 _pageAlive 置 false 并停掉 VK。
        // 回调里必须做两层防护：① 页面已卸载则静默返回；② 页面存活时由 _afterCamGranted
        //   重新拉起 initVK（onShow 只在 _pageAlive=false 时才会走初始化，若回调先于 onShow
        //   执行且已把 _pageAlive 置为 true，onShow 会安全跳过，不冲突）。
        if (!this._pageAlive) return;
        // 从系统设置返回：此时 onShow 可能尚未触发，手动恢复存活标记
        if (res.authSetting['scope.camera']) {
          this._afterCamGranted();
        } else {
          wx.showToast({ title: '未授权摄像头，无法训练', icon: 'none' });
        }
      },
    });
  },

  onUnload() {
    this._pageAlive = false;
    this._stopTimed();
    this._stopElapsed();
    this._stopPrep();
    this._stopGroupTimer();
    this._groupKeepOff();   // 离开页面务必关掉常亮，否则会一直亮屏耗电
    this._stopVK();
    try { voice.stopReport(); } catch (e) { /* 停掉可能在播的里程碑报数 */ }
    if (this._simTimer) { clearInterval(this._simTimer); this._simTimer = null; }
    if (this._focusTimer) { clearTimeout(this._focusTimer); this._focusTimer = null; }
    if (this._beatTimer) { clearTimeout(this._beatTimer); this._beatTimer = null; }
  },

  // 切后台 / 被其它页面覆盖：必须停掉摄像头 + WebGL 渲染循环。
  // 否则 VisionKit 会在后台继续持有相机与 GL 上下文，Android 上极易被系统回收资源后 native 崩溃。
  onHide() {
    this._pageAlive = false;
    this._stopVK();
    if (this._simTimer) { clearInterval(this._simTimer); this._simTimer = null; }
    // 训练中切后台自动暂停，避免回来后时间/计数错乱
    if (this.data.phase === 'running' && this.data.isGroup && this.data.groupRunning) {
      // 分组模式的判据必须是 groupRunning 而不是 isRunning：
      // 组间休息段 isRunning 本来就是 false，用 isRunning 判会漏掉休息中的切后台。
      this._groupPause();
      this.setData({ groupRunning: false, isRunning: false, isPaused: true, statusText: '已暂停（切换到后台）' });
    } else if (this.data.phase === 'running' && this.data.isRunning) {
      this._stopTimed();
      this._stopElapsed();
      this.setData({ isRunning: false, isPaused: true, statusText: '已暂停（切换到后台）' });
    }
    this._stopPrep();
  },

  onShow() {
    if (this._pageAlive) return;          // onReady 首次进入时已由 onReady 负责初始化
    if (!this.counter) return;            // onReady 还没跑过
    this._pageAlive = true;
    this._renderFail = 0;
    if (!this.data.needAuth && this.data.phase !== 'finished') this.initVK();
    // 仅相机已授权时才起倒计时；未授权时由 _afterCamGranted 在授权完成后接管
    if (!this.data.needAuth && this.data.phase === 'prep') this._startPrep();
    // 分组会话进行中：系统可能已把常亮重置掉，回来重新声明一次
    if (this.data.phase === 'running' && this.data.isGroup) this._groupKeepOn();
  },

  _stopVK() {
    const s = this.session;
    this.session = null;   // 先摘引用，onFrame 里的存活检查会立刻生效
    if (s) {
      try { if (this._raf != null && s.cancelAnimationFrame) s.cancelAnimationFrame(this._raf); } catch (e) {}
      try { if (s.off) { s.off('updateAnchors'); s.off('removeAnchors'); } } catch (e) {}
      try { if (s.stop) s.stop(); } catch (e) {}
      try { if (s.destroy) s.destroy(); } catch (e) {}   // 不 destroy 会累积 session，反复进出页面后崩溃
    }
    this._raf = null;
  },

  // —— 准备阶段：统一 5 秒女声倒计时 + 视觉数字（三种模式共用）——
  _startPrep() {
    this._stopPrep();        // 先清掉上一轮 timer/动画，避免 _stopPrep 把刚触发的 prepBeat 复位
    let n = PREP_SECONDS;
    // 倒计时期间相机已在跑，先清掉可能累积的误计，保证进入训练时从 0 开始
    if (this.counter && typeof this.counter.reset === 'function') {
      try { this.counter.reset(); } catch (e) { /* ignore */ }
    }
    this.setData({
      phase: 'prep', isRunning: false, isPaused: false,
      prepNum: n, prepText: '准备', statusText: '准备中…',
      counter: 0, elapsed: 0, elapsedStr: '00:00',
    });
    this._prepBeat();        // 触发首个数字的弹跳动画
    voice.playCount(n);      // 5
    this._prepTimer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        this.setData({ prepNum: n });
        this._prepBeat();
        voice.playCount(n);  // 4,3,2,1
      } else {
        clearInterval(this._prepTimer); this._prepTimer = null;
        this.setData({ prepNum: 0, prepText: '开始' });
        this._prepBeat();
        voice.playStart();
        setTimeout(() => this._enterRunning(), 600);
      }
    }, 1000);
  },

  // 倒计时数字弹跳动画：cover-view 的 keyframes 只在新类名生效时重放，
  // 若上一拍的类还没复位，必须先清掉再在下一帧加回，否则连续数字动画不重放。
  _prepBeat() {
    if (this._prepBeatTimer) { clearTimeout(this._prepBeatTimer); this._prepBeatTimer = null; }
    if (this.data.prepBeat) {
      this.setData({ prepBeat: false }, () => {
        wx.nextTick(() => { if (this._pageAlive) this.setData({ prepBeat: true }); });
      });
    } else {
      this.setData({ prepBeat: true });
    }
    this._prepBeatTimer = setTimeout(() => {
      this._prepBeatTimer = null;
      if (this._pageAlive) this.setData({ prepBeat: false });
    }, 320);
  },

  _stopPrep() {
    if (this._prepTimer) { clearInterval(this._prepTimer); this._prepTimer = null; }
    if (this._prepBeatTimer) { clearTimeout(this._prepBeatTimer); this._prepBeatTimer = null; }
    // onUnload/onHide 会先置 _pageAlive=false，此时不再 setData（页面已不可渲染）
    if (this._pageAlive && this.data.prepBeat) this.setData({ prepBeat: false });
  },

  // 进入正式训练（准备倒计时结束后进入）
  _enterRunning() {
    if (!this._pageAlive || !this.counter) return;  // 页面已卸载 / VK 未就绪时可能被提前触发
    // 倒计时期间相机在跑，可能已累积误计 —— 进入训练前清空，保证计数从 0 开始
    if (typeof this.counter.reset === 'function') {
      try { this.counter.reset(); } catch (e) { /* ignore */ }
    }
    this._startTs = Date.now();
    this._saved = false;
    this._doneSpoken = false;
    this._lastRemain = null;
    this._lastMilestone = 0;    // 策略C：里程碑报数游标（已报到的最新整十数）
    this._muteMilestone = false; // 策略C：倒数期间静音里程碑，避免叠音
    this.setData({
      phase: 'running', isRunning: true, isPaused: false, statusText: '训练中',
      counter: 0, elapsed: 0, elapsedStr: '00:00',
    });
    if (this.data.isGroup) {
      // 分组训练：不进 _startTimed / _startElapsed，改走「工作组 ⇄ 组间休息」分段状态机。
      // 净训练用时由 _groupSyncElapsed 按墙钟累计 —— 这里**不能**再起 _startElapsed，
      // 否则「每秒 +1」与墙钟推导两个写入方会互相打架，HUD 上会出现 ±1 秒的跳动。
      this._startGroupSession();
    } else {
      this._startElapsed();
      if (this.data.mode === 'timed') {
        this.setData({ totalSeconds: this.data.duration, timeStr: fmtTime(this.data.duration) });
        this._startTimed();
      }
    }
  },

  // 策略C：每满 10 跳报一次当前总数。
  // 互斥规则（防叠音）：
  //   · 只在 phase==='running' 且未静音时报；
  //   · 定数模式「最后 10 个倒数」/ 定时模式「最后 10 秒倒数」期间静音里程碑；
  //   · 报的必须是「已跨过的最新整十数」，避免同一里程碑重复报。
  _tryMilestoneReport(count) {
    if (this.data.phase !== 'running' || !this.data.isRunning) return;
    if (this._muteMilestone) return;
    const m = Math.floor(count / 10) * 10;
    if (m < 10 || m <= (this._lastMilestone || 0)) return;

    // 定数模式（非分组）：离目标 ≤10 时交给「倒数」，里程碑让位
    if (this.data.mode === 'counted' && !this.data.isGroup && (this.data.target - count) <= 10) return;
    // 定时模式（含定时分组的工作组）：本段剩余 ≤10 秒时交给「秒倒数」，里程碑让位
    if (this.data.mode === 'timed' && this.data.totalSeconds <= 10) return;

    this._lastMilestone = m;
    voice.playMilestone(m);
  },

  // 已用时间计时（所有模式通用，用于结果/副显示）
  _startElapsed() {
    this._stopElapsed();
    this._elapsedTimer = setInterval(() => {
      if (!this._pageAlive || !this.data.isRunning) return;
      const e = this.data.elapsed + 1;
      this.setData({ elapsed: e, elapsedStr: fmtTime(e) });
    }, 1000);
  },
  _stopElapsed() {
    if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
  },

  // 定时模式主计时
  _startTimed() {
    this._stopTimed();
    this._timedTimer = setInterval(() => {
      if (!this.data.isRunning) return;
      const next = this.data.totalSeconds - 1;
      if (next > 0) {
        if (next <= 10) {
          // 结束前 10 秒进入「秒倒数」：静音里程碑并打断可能正在播的报数，防叠音
          if (!this._muteMilestone) { this._muteMilestone = true; voice.stopReport(); }
          voice.playCount(next);
        }
        this.setData({ totalSeconds: next, timeStr: fmtTime(next) });
      } else {
        this.setData({ totalSeconds: 0, timeStr: '00:00' });
        this._stopTimed();
        voice.playTimeUp();
        this._finish();
      }
    }, 1000);
  },
  _stopTimed() {
    if (this._timedTimer) { clearInterval(this._timedTimer); this._timedTimer = null; }
  },

  // ═══════════ 分组训练（isGroup，叠加在模式之上）═══════════
  // 状态机：准备(5s) → 工作组 ⇄ 组间休息 →（第 N 组结束）→ 结算
  //
  // 分组是「模式」之上的开关，每组结束条件随模式不同：
  //   · timed   分组：每组计时到 groupWork 秒自动结束
  //   · counted 分组：每组达到 groupWork 个自动结束（组内个数 = 当前总数 − 本组起点）
  //   · free    分组：每组不设自动结束，用户点「结束本组」才进休息
  //
  // 三个通用语义：
  //   · 完成个数 = 全程累计总数（counter 从不清零，_finish 取到的天然就是总个数）
  //   · 第 N 组结束**不加尾休**，直接结算
  //   · 用时 = 净训练时长（只有工作组累计，休息段不计）
  //
  // 计时**一律按墙钟推导**（_phaseEndTs 绝对时间戳 + ceil 求剩余），
  // 不用「每秒 -1」累减 —— setInterval 的迟到会累积成可观误差，而分组会话最长可达 77 分钟
  // （10 组 × 300 秒 + 9 次 × 180 秒休息）。
  _startGroupSession() {
    this._stopGroupTimer();
    this._groupNo = 1;
    this._groupPhase = 'work';
    this._groupWorkMs = 0;     // 已累计的工作段毫秒数（净训练时长的唯一真值）
    this._workStartTs = 0;
    this._setStartCount = 0;   // 当前工作组的「组内起点总数」（counted 分组用）
    this._groupKeepOn();       // 长会话：会话期间不允许息屏（息屏 = 切后台 = 停相机 + 暂停）
    this.setData({
      groupNo: 1, groupPhase: 'work', groupResting: false, groupRunning: false,
      groupSetCount: 0, groupSetTarget: this.data.groupWork,
    });
    this._startGroupWork(true);
  },

  // 工作段计时结算：把「本次工作段已走的毫秒」并入总额。
  // 净训练时长走墙钟累计而不是复用 _startElapsed 的「每秒 +1」——
  // 后者在每一段结束（clearInterval）时都会截掉不足 1 秒的零头，3 组就能少算近 3 秒，
  // 结果页会出现「3×60 秒 = 02:57」这种看起来像丢数据的数字。
  _groupBankWork() {
    if (this._workStartTs) {
      this._groupWorkMs = (this._groupWorkMs || 0) + (Date.now() - this._workStartTs);
      this._workStartTs = 0;
    }
  },
  // 按墙钟刷新「净训练用时」显示（工作段）
  _groupSyncElapsed() {
    const ms = (this._groupWorkMs || 0) + (this._workStartTs ? Date.now() - this._workStartTs : 0);
    const sec = Math.floor(ms / 1000);
    if (sec !== this.data.elapsed) this.setData({ elapsed: sec, elapsedStr: fmtTime(sec) });
  },

  _startGroupWork(first) {
    if (!this._pageAlive) return;
    this._stopGroupTimer();
    const work = this.data.groupWork;
    // 休息段计数器一帧都没收到，内部时基还停在上一组结束那一刻。直接恢复会让休息空档
    // 被当成一个巨大的 dt 样本写进 intervals（抬高 Tmed，连带污染冷却下限与防卡死兜底）。
    // 所以必须清跟踪态 —— 但**保留已计数量**，故用 resetTrackingKeepCount() 而不是 reset()。
    if (!first && this.counter && typeof this.counter.resetTrackingKeepCount === 'function') {
      try { this.counter.resetTrackingKeepCount(); } catch (e) { /* ignore */ }
    }
    this._groupPhase = 'work';
    this._muteMilestone = false;     // 新一组恢复里程碑报数
    this._groupLastRemain = null;
    this._groupRemainMs = 0;
    this._workStartTs = Date.now();
    // 每组结束条件随模式不同：timed 用墙钟截止；counted/free 不靠时间（_phaseEndTs 置 0，由 tick 各自判定）
    this._phaseEndTs = (this.data.mode === 'timed') ? (this._workStartTs + work * 1000) : 0;
    // counted 分组：记录本组起点总数，用于算「组内已完成个数」
    if (this.data.mode === 'counted') this._setStartCount = (this.counter && this.counter.counter) || 0;

    let statusText;
    if (this.data.mode === 'counted') {
      statusText = '第 ' + this._groupNo + ' / ' + this.data.groupSets + ' 组 · 目标 ' + work + ' 个';
    } else if (this.data.mode === 'free') {
      statusText = '第 ' + this._groupNo + ' / ' + this.data.groupSets + ' 组 · 自由练（点「结束本组」进休息）';
    } else {
      statusText = '第 ' + this._groupNo + ' / ' + this.data.groupSets + ' 组进行中';
    }
    const patch = {
      groupPhase: 'work', groupNo: this._groupNo, groupResting: false,
      groupRunning: true, isRunning: true, isPaused: false,
      groupSetCount: 0, groupSetTarget: work,
      statusText,
    };
    if (this.data.mode === 'timed') { patch.totalSeconds = work; patch.timeStr = fmtTime(work); }
    this.setData(patch);
    if (!first) voice.playStart();   // 休息结束 → 复用现成的「开始」语音
    this._groupSyncElapsed();
    this._groupTimer = setInterval(() => this._groupTick(), 250);
  },

  // 进入组间休息：暂停计数（isRunning=false），但会话时钟仍在走（groupRunning=true）
  _startGroupRest() {
    if (!this._pageAlive) return;
    this._stopGroupTimer();
    const rest = this.data.groupRest;
    this._groupPhase = 'rest';
    this._groupLastRemain = null;
    this._groupRemainMs = 0;
    this._phaseEndTs = Date.now() + rest * 1000;
    this.setData({
      groupPhase: 'rest', groupResting: true,
      groupRunning: true, isRunning: false, isPaused: false,
      groupRestNum: rest, groupRestStr: fmtTime(rest),
      statusText: '本组完成，休息一下',
    });
    this._groupTimer = setInterval(() => this._groupTick(), 250);
  },

  // 分段 tick：按墙钟算剩余（250ms 一次，只在数值变化时 setData）。
  // 工作段结束条件随模式不同：timed 靠时间、counted 靠个数、free 靠用户手动（见 _groupEndWork）。
  _groupTick() {
    if (!this._pageAlive || this.data.phase !== 'running' || !this.data.groupRunning) {
      this._stopGroupTimer();
      return;
    }
    if (this._groupPhase === 'work') {
      this._groupSyncElapsed();
      if (this.data.mode === 'timed') {
        const remain = Math.max(0, Math.ceil((this._phaseEndTs - Date.now()) / 1000));
        if (remain !== this.data.totalSeconds) this.setData({ totalSeconds: remain, timeStr: fmtTime(remain) });
        // 本组最后 10 秒走「秒倒数」，期间静音里程碑防叠音（与定时模式同一套规则）
        if (remain > 0 && remain <= 10 && remain !== this._groupLastRemain) {
          this._groupLastRemain = remain;
          if (!this._muteMilestone) { this._muteMilestone = true; voice.stopReport(); }
          voice.playCount(remain);
        }
        if (remain <= 0) this._onGroupPhaseEnd();
      } else if (this.data.mode === 'counted') {
        const setCount = (this.counter && this.counter.counter ? this.counter.counter : 0) - (this._setStartCount || 0);
        const rem = this.data.groupWork - setCount;
        if (setCount !== this.data.groupSetCount) this.setData({ groupSetCount: setCount });
        // 本组接近目标（剩 ≤10 个）静音里程碑，把报数让给倒数
        if (rem > 0 && rem <= 10 && !this._muteMilestone) { this._muteMilestone = true; voice.stopReport(); }
        if (rem <= 0) this._onGroupPhaseEnd();
      }
      // free 分组：工作组不自动结束，等用户点「结束本组」；这里仅同步净训练用时
    } else {
      const remain = Math.max(0, Math.ceil((this._phaseEndTs - Date.now()) / 1000));
      if (remain !== this.data.groupRestNum) {
        this.setData({ groupRestNum: remain, groupRestStr: fmtTime(remain) });
        if (remain > 0 && remain <= 3) voice.playCount(remain);   // 休息末 3 秒直接复用现有倒数语音
      }
      if (remain <= 0) this._onGroupPhaseEnd();
    }
  },

  // 自由分组：用户手动「结束本组」→ 收尾（最后一组直接结算，否则进休息）
  _groupEndWork() {
    if (!this.data.isGroup || this.data.mode !== 'free' || this._groupPhase !== 'work' || !this.data.groupRunning) return;
    voice.playTimeUp();
    this._onGroupPhaseEnd();
  },

  // 一段结束：工作组到点 → 还有下一组就休息，否则结算；休息结束 → 进下一组
  _onGroupPhaseEnd() {
    this._stopGroupTimer();
    if (this._groupPhase === 'work') {
      this._groupBankWork();
      if (this._groupNo >= this.data.groupSets) {
        // 第 N 组到点：不加尾休，直接结算
        this._groupSyncElapsed();    // 结算前按墙钟对齐一次，结果页的用时不受 250ms tick 相位影响
        try { voice.stopReport(); } catch (e) { /* ignore */ }
        voice.playDone();            // 与定数达标同一套「完成」语音
        this._finish();
      } else {
        voice.playTimeUp();          // 「时间到」= 本组结束，语义正好
        this._startGroupRest();
      }
    } else {
      this._groupNo += 1;
      this._startGroupWork(false);
    }
  },

  _stopGroupTimer() {
    if (this._groupTimer) { clearInterval(this._groupTimer); this._groupTimer = null; }
  },

  // 暂停：把「本段还剩多久」存下来，恢复时按墙钟重新推一个截止时刻。
  // 这样暂停 / 切后台期间流逝的时间都不会被算进组时长。
  _groupPause() {
    this._groupBankWork();
    // 只有带时间截止的段（定时工作组 / 任何休息段）才需要存剩余时间。
    // 定数/自由的工作段 _phaseEndTs 为 0，不存（恢复后继续等达标/手动结束）。
    if (this._phaseEndTs) this._groupRemainMs = Math.max(0, this._phaseEndTs - Date.now());
    this._stopGroupTimer();
    this._stopElapsed();
  },
  _groupResume() {
    if (this._groupPhase === 'work' && this.data.mode !== 'timed') {
      // 定数/自由分组的工作段没有时间截止，恢复后继续等「达标」或「手动结束本组」
      this._phaseEndTs = 0;
    } else {
      this._phaseEndTs = Date.now() + (this._groupRemainMs || 0);
    }
    this._groupRemainMs = 0;
    if (this._groupPhase === 'work') {
      this._workStartTs = Date.now();
      this.setData({
        groupRunning: true, isRunning: true, isPaused: false,
        statusText: '第 ' + this._groupNo + ' / ' + this.data.groupSets + ' 组进行中',
      });
    } else {
      this.setData({ groupRunning: true, isRunning: false, isPaused: false, statusText: '本组完成，休息一下' });
    }
    this._groupTimer = setInterval(() => this._groupTick(), 250);
  },

  // 分组会话期间屏幕常亮：中途息屏 = 切后台 = onHide 停相机 + 自动暂停，
  // 是长会话最容易翻车的一条（3×60 + 2×30 已经 4 分钟，最长配置 77 分钟）。
  _groupKeepOn() {
    if (typeof wx.setKeepScreenOn === 'function') {
      try { wx.setKeepScreenOn({ keepScreenOn: true }); } catch (e) { /* ignore */ }
    }
  },
  _groupKeepOff() {
    if (typeof wx.setKeepScreenOn === 'function') {
      try { wx.setKeepScreenOn({ keepScreenOn: false }); } catch (e) { /* ignore */ }
    }
  },

  // 训练结束 → 结果摘要
  _finish() {
    this._stopTimed();
    this._stopGroupTimer();
    this._stopElapsed();
    this._stopPrep();
    this._groupKeepOff();                    // 会话结束立刻放开屏幕常亮
    this._muteMilestone = true;              // 结束后不再报里程碑
    try { voice.stopReport(); } catch (e) { /* 打断可能在播的报数，给结束音让路 */ }
    // 结果页不需要相机：先释放 VisionKit 与 WebGL 渲染循环，再去画分享卡片。
    // 「相机流 + WebGL 每帧绘制 + canvas2d 导出图片」同时进行是低端安卓上的崩溃组合。
    this._stopVK();
    this.setData({
      phase: 'finished',
      isRunning: false,
      isPaused: false,
      // 分组模式：清掉会话态（休息中被打断时不能把「休息」留在结果页上）
      groupRunning: false, groupResting: false, groupPhase: '',
      resultCount: (this.counter && this.counter.counter) || 0,
      resultElapsed: this.data.elapsed,
      resultElapsedStr: this.data.elapsedStr,
      statusText: '训练结束',
    });

    // 落库一条训练记录（去重：每次训练仅保存一次）
    if (!this._saved) {
      this._saved = true;
      try {
        const c = this.counter && this.counter.counter ? this.counter.counter : 0;
        records.saveRecord({
          ts: this._startTs || Date.now(),
          sport: this.data.sport,
          mode: this.data.mode,
          count: c,
          durationSec: this.data.elapsed,
        });
      } catch (e) {
        console.error('[records] save failed:', e);
      }
    }

    // 生成分享卡片标题 + 触发 canvas 绘制
    const sportName = this.data.sport === 'volleyball' ? '垫排球' : '跳绳';
    const baseName = { timed: '定时', counted: '定数', free: '自由' }[this.data.mode] || '自由';
    const modeName = this.data.isGroup ? baseName + '（分组）' : baseName;
    const mm = String(Math.floor(this.data.elapsed / 60)).padStart(2, '0');
    const ss = String(this.data.elapsed % 60).padStart(2, '0');
    this.setData({
      shareTitle: `刚刚完成了${modeName}${sportName} ${this.data.resultCount} 个，用时 ${mm}:${ss}`,
    });
    this._drawShareCard();
  },

  // —— VisionKit 初始化（保留原管线）——
  initVK() {
    if (this.session) this._stopVK();   // 幂等：onShow 重入时先清掉旧会话，避免叠加多个 VKSession
    this._pageAlive = true;
    wx.createSelectorQuery()
      .select('#webgl')
      .node()
      .exec((res) => {
        if (!this._pageAlive) return;   // 异步回调返回时页面可能已卸载
        if (!res || !res[0] || !res[0].node) return this._fallbackSim('找不到 webgl canvas');
        this.canvas = res[0].node;
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const dpr = info.pixelRatio || 1;
        this.canvas.width = info.windowWidth * dpr;
        this.canvas.height = info.windowHeight * dpr;
        this.gl = this.canvas.getContext('webgl');
        if (!this.gl) return this._fallbackSim('WebGL 不可用');

        try {
          // 同一个 canvas 的 GL 上下文是复用的，着色器/缓冲只需建一次；
          // 重复建会持续泄漏 program 与 buffer，反复进出页面后耗尽显存
          if (!this._glInited) { this._initYUVShader(); this._glInited = true; }
          const session = this.session = wx.createVKSession({
            track: { body: { mode: 1 } },
            gl: this.gl,
            version: 'v1',
          });
            session.start((err) => {
            if (err) return this._fallbackSim('VisionKit 启动失败: ' + err);
            // 启动回调是异步的：期间页面可能已卸载/切后台，此时必须就地销毁，绝不能挂回调
            if (!this._pageAlive || this.session !== session) {
              try { session.stop && session.stop(); } catch (e) {}
              try { session.destroy && session.destroy(); } catch (e) {}
              return;
            }
            this.setData({ poseState: 'ready', statusText: '识别已就绪' });
            session.on('updateAnchors', (anchors) => {
              if (!this._pageAlive || this.session !== session) return;
              try { this._onAnchors(anchors); } catch (e) { console.error('[VK] updateAnchors error:', e && e.message); }
            });
            session.on('removeAnchors', () => {
              if (!this._pageAlive || this.session !== session) return;
              try { this._onRemoveAnchors(); } catch (e) { console.error('[VK] removeAnchors error:', e && e.message); }
            });
            const onFrame = () => {
              // 存活检查必须在「重新注册 rAF」之前：页面卸载/切后台后立即断链，
              // 否则闭包里的旧 session 会一直自我续命，并在已释放的 GL 上下文上绘制 → native 崩溃
              if (!this._pageAlive || this.session !== session || !this.gl || !this.canvas) return;
              this._raf = session.requestAnimationFrame(onFrame);
              try {
                const frame = session.getVKFrame(this.canvas.width, this.canvas.height);
                if (frame) {
                  this._renderCamera(frame);
                  this._maybeSampleRope(frame);
                } else this._onRenderFail('getVKFrame 返回空');
              } catch (e) {
                this._onRenderFail('渲染抛错: ' + ((e && e.message) || e));
              }
            };
            this._raf = session.requestAnimationFrame(onFrame);
          });
        } catch (e) {
          this._fallbackSim('VisionKit 初始化异常: ' + ((e && e.message) || e));
        }
      });
  },

  // 人体离开画面：清「跟踪态」但**保留已计数量**，并提示用户回到取景框内。
  //
  // ⚠️ 这里原来调用 counter.reset()，而 reset() 会把计数清零。训练中途人体短暂出框、
  //    或 VisionKit 瞬时丢跟踪，都会触发 removeAnchors → 已跳/已垫数量直接归零，
  //    一组训练成绩作废（用户实测反馈的 bug）。出框只该「暂停计数」，不该「清空成绩」。
  _onRemoveAnchors() {
    this._inFrame = false;
    this._outFrameCount = 0;
    if (this.counter && typeof this.counter.resetTrackingKeepCount === 'function') {
      try { this.counter.resetTrackingKeepCount(); } catch (e) { /* ignore */ }
    }
    // 兜底说明：拿不到新接口时**故意什么都不做**。跟踪态陈旧无妨——下一帧 update()
    // 的「检测中断」分支会自动 _fullReset()；但绝不能退回去调会把成绩清零的 reset()。
    const patch = { inFrame: false };
    // 组间休息时人走开是正常的，不该弹「请回到取景框」；角标变红也由 WXML 用 groupResting 抑制
    if (this.data.phase === 'running' && !this.data.groupResting) patch.statusText = '请将身体移入取景框';
    if (this.data.showDebug) {
      patch.debugPoints = []; patch.vkPointsLen = 0; patch.vkMissingIdx = '';
      if (this.data.phase !== 'running') patch.statusText = '人体已离开画面';
    }
    if (this._pageAlive) this.setData(patch);
  },

  // 处理每帧关键点
  _onAnchors(anchors) {
    if (!anchors || !anchors.length) return;
    const anchor = anchors[0];
    const points = anchor && anchor.points;
    if (!points || !points.length) return;

    // 调试浮层：debugPoints 是 wx:for 出来的 cover-view（原生组件）。
    // 按帧率(30fps)刷新会让原生层每秒重建 690 个视图 → Android 上直接 ANR / 闪退。
    // 这里统一节流到 ~6fps，并把点数/缺失诊断合并进同一次 setData。
    if (this.data.showDebug) {
      const tNow = Date.now();
      if (!this._lastDbgPush || tNow - this._lastDbgPush > 160) {
        this._lastDbgPush = tNow;
        const missing = [];
        for (let i = 0; i < 14; i++) {
          const p = points[i];
          if (!p || p.x == null || p.y == null) missing.push(i);
        }
        // 路线A：给每个点打解剖标记，浮层按部位着色，便于肉眼判定索引是否落在正确关节上。
        const ROLE = {};
        ROLE[BODY_IDX.NOSE] = 'nose';
        ROLE[BODY_IDX.L_SHOULDER] = ROLE[BODY_IDX.R_SHOULDER] = 'sh';
        ROLE[BODY_IDX.L_HIP] = ROLE[BODY_IDX.R_HIP] = 'hip';
        ROLE[BODY_IDX.L_KNEE] = ROLE[BODY_IDX.R_KNEE] = 'knee';
        ROLE[BODY_IDX.L_ANKLE] = ROLE[BODY_IDX.R_ANKLE] = 'ankle';
        ROLE[BODY_IDX.L_WRIST] = ROLE[BODY_IDX.R_WRIST] = 'wrist';
        ROLE[BODY_IDX.L_ELBOW] = ROLE[BODY_IDX.R_ELBOW] = 'elbow';
        const dbg = [];
        for (let i = 0; i < points.length; i++) {
          if (points[i]) dbg.push({ idx: i, x: points[i].x, y: points[i].y, role: ROLE[i] || 'other' });
        }
        // 路线A：当前 BODY_IDX 映射下的解剖序自检（肩<髋<膝<踝，且左.x<右.x）
        const gp = (k) => pick(points, BODY_IDX[k]);
        const sL = gp('L_SHOULDER'), sR = gp('R_SHOULDER'), hL = gp('L_HIP'), hR = gp('R_HIP');
        const kL = gp('L_KNEE'), kR = gp('R_KNEE'), aL = gp('L_ANKLE'), aR = gp('R_ANKLE');
        let mapOk = null, mapHint = '';
        if (sL && sR && hL && hR && kL && kR && aL && aR) {
          const sy = (sL.y + sR.y) / 2, hy = (hL.y + hR.y) / 2, ky = (kL.y + kR.y) / 2, ay = (aL.y + aR.y) / 2;
          const sh2ank = Math.max(1e-3, ay - sy);
          const hipRatio = (hy - sy) / sh2ank;   // 髋应在肩→踝全长的 0.35~0.72
          const orderOk = (sy < hy) && (hy < ky) && (ky < ay);
          const xOk = (sL.x < sR.x) && (hL.x < hR.x) && (aL.x < aR.x);
          const ratioOk = hipRatio > 0.35 && hipRatio < 0.72;
          mapOk = orderOk && xOk && ratioOk;
          mapHint = mapOk
            ? `映射✓ 髋位${(hipRatio * 100).toFixed(0)}%(应在35~72%)`
            : `映射异常 髋位${(hipRatio * 100).toFixed(0)}% 序${orderOk ? '✓' : '✗'} X${xOk ? '✓' : '✗'}`;
        } else {
          mapHint = '关键点不全，无法自检';
        }
        // 路线A：候选流派匹配度（只读提示，不改变 BODY_IDX）
        const candHit = LAYOUT_CANDIDATES.map((L) => `${L.name}${_layoutMatches(points, L) ? '✓' : '×'}`).join(' ');
        this._dbgTick = true;   // 同一节拍顺带允许刷新下方诊断面板数值
        this.setData({
          debugPoints: dbg, vkPointsLen: points.length, vkMissingIdx: missing.join(','),
          mapOk, mapHint, candHint: candHit,
        });
        if (!this._lastVkDiagTs || tNow - this._lastVkDiagTs > 2000) {
          this._lastVkDiagTs = tNow;
          console.log('[VK] points.length=', points.length, 'missing(0-13)=', missing, 'source=', anchor.source || 'unknown', 'mapOk=', mapOk);
        }
      }
    }

    const shL = pick(points, BODY_IDX.L_SHOULDER);
    const shR = pick(points, BODY_IDX.R_SHOULDER);
    const hipL = pick(points, BODY_IDX.L_HIP);
    const hipR = pick(points, BODY_IDX.R_HIP);
    const ankL = pick(points, BODY_IDX.L_ANKLE);
    const ankR = pick(points, BODY_IDX.R_ANKLE);
    const kneeL = pick(points, BODY_IDX.L_KNEE);
    const kneeR = pick(points, BODY_IDX.R_KNEE);
    const wristL = pick(points, BODY_IDX.L_WRIST);
    const wristR = pick(points, BODY_IDX.R_WRIST);
    const elbowL = pick(points, BODY_IDX.L_ELBOW);
    const elbowR = pick(points, BODY_IDX.R_ELBOW);
    const nose = pick(points, BODY_IDX.NOSE);
    // 任一可见即用：两端都在取中点；只有一端可见用那端；都无才丢弃。
    // 绳索/手臂/取景框遮挡单侧时不再整帧丢帧，避免漏计。
    const jx = (L, R) => {
      if (L && R) return { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
      if (L) return { x: L.x, y: L.y };
      if (R) return { x: R.x, y: R.y };
      return null;
    };
    const hipC = jx(hipL, hipR);
    const shC = jx(shL, shR);
    const ankC = jx(ankL, ankR);
    if (!(hipC && shC)) return;

    // 取景框规则①：有效计数区（ROI）+ grace 保护
    const hipCx = hipC.x, hipCy = hipC.y, shCy = shC.y;
    const reliable = isFinite(hipCx) && isFinite(hipCy) && isFinite(shCy);
    const inside =
      hipCx >= ROI.xMin && hipCx <= ROI.xMax &&
      hipCy >= ROI.yMin && hipCy <= ROI.yMax &&
      shCy >= ROI.yMin && shCy <= ROI.yMax;
    if (!(reliable && inside)) {
      this._outFrameCount = (this._outFrameCount || 0) + 1;
      if (this._outFrameCount >= OUTFRAME_GRACE && this._inFrame !== false) {
        this._inFrame = false;
        // 组间休息时人走开是正常的：不覆盖状态文案（角标变红由 WXML 用 groupResting 抑制）
        const patch = { inFrame: false };
        if (!this.data.groupResting) patch.statusText = '请将身体移入取景框';
        this.setData(patch);
      }
      return;
    }
    this._outFrameCount = 0;

    // 取景框规则②：尺度校准（踝缺失时跳过校验，仅作兜底）
    const shMid = shC.y;
    let bodyH = ankC ? (ankC.y - shMid) : null;
    if (bodyH != null && !(bodyH > 1e-3)) {
      if (this._inFrame !== false) {
        this._inFrame = false;
        this.setData({ inFrame: false, statusText: '姿态识别异常' });
      }
      return;
    }
    if (bodyH != null) {
      bodyH = Math.min(Math.max(bodyH, CALIB * 0.6), CALIB * 1.4);
    } else {
      bodyH = CALIB;
    }

    if (this._inFrame !== true) {
      this._inFrame = true;
      const patch = { inFrame: true };
      if (!this.data.groupResting) patch.statusText = '识别已就绪';
      this.setData(patch);
    }

    if (!this.data.isRunning || this.data.phase !== 'running') {
      this._lastTs = Date.now();
      return;
    }

    // 六通道（跳绳）特征（任一可见即用）
    const kneeC = jx(kneeL, kneeR);
    const wristC = jx(wristL, wristR);
    const haveKnee = !!kneeC;
    const haveWrist = !!wristC;
    const haveElbow = !!(elbowL && elbowR);
    const hip = hipC.y;
    const ankle = ankC ? ankC.y : null;
    const knee = kneeC ? kneeC.y : null;
    const wrist = wristC ? wristC.y : null;
    let leg = null;
    if (kneeL && ankL && kneeR && ankR) {
      leg = ((Math.abs(ankR.y - kneeR.y)) + (Math.abs(ankL.y - kneeL.y))) / 2;
    } else if (kneeL && ankL) {
      leg = Math.abs(ankL.y - kneeL.y);
    } else if (kneeR && ankR) {
      leg = Math.abs(ankR.y - kneeR.y);
    }
    const shoulder = shMid;

    // ⚠️ 必须显式传真实时间戳。不传时计数器会退化成「帧序号 × 33.3ms」的假时基，
    // 真机 VisionKit 回调常掉到 15~20fps，假时基下 250ms 冷却实际等于 400~500ms → 快跳被吃掉（漏计）。
    // 同时 feedRope() 用的就是 Date.now()，不统一时基会让 ROPE 门禁信号永远对不上。
    const now = Date.now();
    let r;
    if (this.data.sport === 'volleyball') {
      const volElbow = haveElbow ? (elbowL.y + elbowR.y) / 2 : null;
      r = this.counter.update({ wrist, elbow: volElbow }, now);
    } else {
      r = this.counter.update({
        hip,
        hipX: hipCx,   // P2b：X 轴水平稳定性门（走动时暂停计数）需要髋中心 X
        ankle,
        knee,
        wrist,
        leg,
        shoulder,
      }, now);
    }

    this._fps = Math.round(1000 / Math.max(1, now - this._lastTs));
    this._lastTs = now;
    const patch = {};
    if (r.counter !== this.data.counter) {
      patch.counter = r.counter;
      // 计数变化时触发“暴击”动画：数字放大回弹 + 胶囊发亮。
      // cover-view 的 keyframes 只在新类名生效时重放；若上一拍的类还没复位，
      // 必须先清掉再在下一帧加回，否则连续快跳时动画不重放。
      if (r.counter > this.data.counter) {
        if (this._beatTimer) { clearTimeout(this._beatTimer); this._beatTimer = null; }
        if (this.data.countBeat) {
          this.setData({ countBeat: false }, () => {
            wx.nextTick(() => { if (this._pageAlive) this.setData({ countBeat: true }); });
          });
        } else {
          patch.countBeat = true;
        }
        this._beatTimer = setTimeout(() => {
          this._beatTimer = null;
          if (this._pageAlive) this.setData({ countBeat: false });
        }, 240);

        // 策略C：每满 10 跳报一次当前总数（10/20/30…）。
        // 只在「正式训练中」报，避免准备倒数阶段误报。
        this._tryMilestoneReport(r.counter);
      }
    }
    if (r.status !== this.data.status) patch.status = r.status;
    // fps 每帧都在抖，逐帧 setData 等于每帧跨线程通信一次；降到 2Hz 足够看
    if (now - (this._lastFpsPush || 0) > 500) {
      this._lastFpsPush = now;
      if (this._fps !== this.data.fps) patch.fps = this._fps;
    }

    // 定数模式（非分组）：接近目标前 10 个 语音倒数
    if (this.data.mode === 'counted' && !this.data.isGroup) {
      const rem = this.data.target - r.counter;
      if (rem <= 0) {
        if (!this._doneSpoken) { this._doneSpoken = true; voice.stopReport(); voice.playDone(); }
        this._finish();
        return;
      } else if (rem <= 10 && rem !== this._lastRemain) {
        this._lastRemain = rem;
        // 进入倒数区间：静音里程碑并打断在播报数，避免与倒数叠音
        this._muteMilestone = true;
        voice.stopReport();
        voice.playCount(rem);
      }
    }

    // 调试面板与调试点用同一个节流节拍（~6fps），避免每帧全量刷 20 个字段
    if (this.data.showDebug && this._dbgTick) {
      this._dbgTick = false;
      const d = this.counter.debug || {};
      if (this.data.sport === 'volleyball') {
        patch.dbgWrist = +d.wrist.amp.toFixed(3);
        patch.dbgElbow = d.elbow ? +d.elbow.amp.toFixed(3) : 0;
        patch.dbgStdW = +d.wrist.std.toFixed(3);
        patch.dbgVotes = d.votes;
      } else {
        patch.dbgHip = +d.hip.amp.toFixed(3);
        patch.dbgAnk = +d.ankle.amp.toFixed(3);
        patch.dbgKnee = +d.knee.amp.toFixed(3);
        patch.dbgWrist = +d.wrist.amp.toFixed(3);
        patch.dbgFoot = +d.foot.amp.toFixed(3);
        patch.dbgShoulder = +d.shoulder.amp.toFixed(3);
        patch.dbgStd = +d.hip.std.toFixed(3);
        patch.dbgVotes = d.votes;
        patch.dbgWeight = d.weight;
        patch.dbgGateAgree = d.gateAgree;
        patch.dbgGateNeed = d.gateNeed;
        patch.dbgRejected = d.rejected;
        patch.dbgArmSig = d.gateArm; patch.dbgFootSig = d.gateFoot; patch.dbgAccelSig = d.gateAccel; patch.dbgRopeSig = d.gateRope;
      }
    }
    // 空 patch 不发：setData 每次都要跨 逻辑层→渲染层 通信，30fps 空发是纯浪费
    for (const k in patch) { this.setData(patch); break; }
  },

  // —— WebGL 渲染（保留原管线）——
  _initYUVShader() {
    const gl = this.gl;
    const vs = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      uniform mat3 displayTransform;
      varying vec2 v_texCoord;
      void main() {
        vec3 p = displayTransform * vec3(a_position, 0);
        gl_Position = vec4(p, 1);
        v_texCoord = a_texCoord;
      }`;
    const fs = `
      precision highp float;
      uniform sampler2D y_texture;
      uniform sampler2D uv_texture;
      varying vec2 v_texCoord;
      void main() {
        vec4 y_color = texture2D(y_texture, v_texCoord);
        vec4 uv_color = texture2D(uv_texture, v_texCoord);
        float Y = y_color.r;
        float U = uv_color.r - 0.5;
        float V = uv_color.a - 0.5;
        float R = Y + 1.402 * V;
        float G = Y - 0.344 * U - 0.714 * V;
        float B = Y + 1.772 * U;
        gl_FragColor = vec4(R, G, B, 1.0);
      }`;
    const vsS = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vsS, vs); gl.compileShader(vsS);
    const fsS = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fsS, fs); gl.compileShader(fsS);
    const program = this._program = gl.createProgram();
    gl.attachShader(program, vsS); gl.attachShader(program, fsS); gl.linkProgram(program);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'y_texture'), 5);
    gl.uniform1i(gl.getUniformLocation(program, 'uv_texture'), 6);
    this._dt = gl.getUniformLocation(program, 'displayTransform');
    const posAttr = gl.getAttribLocation(program, 'a_position');
    const tcAttr = gl.getAttribLocation(program, 'a_texCoord');
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1, 1, -1, 1, 1, -1, -1, -1]), gl.STATIC_DRAW);
    const tcBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tcBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1, 1, 0, 1, 1, 0, 0, 0]), gl.STATIC_DRAW);
    this._useVAO = false;
    const ext = gl.getExtension('OES_vertex_array_object');
    if (ext) {
      this._vaoExt = ext;
      const vao = ext.createVertexArrayOES();
      ext.bindVertexArrayOES(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(posAttr);
      gl.bindBuffer(gl.ARRAY_BUFFER, tcBuf);
      gl.vertexAttribPointer(tcAttr, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(tcAttr);
      ext.bindVertexArrayOES(null);
      this._vao = vao;
      this._useVAO = true;
    }
    this._posBuf = posBuf; this._tcBuf = tcBuf; this._posAttr = posAttr; this._tcAttr = tcAttr;
  },

  _renderCamera(frame) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    const tex = frame.getCameraTexture(gl, 'yuv');
    const yTexture = tex && tex.yTexture;
    const uvTexture = tex && tex.uvTexture;
    const displayTransform = frame.getDisplayTransform && frame.getDisplayTransform();
    if (!yTexture || !uvTexture) { this._onRenderFail('无相机纹理(yuv)'); return; }
    if (!displayTransform) { this._onRenderFail('无 displayTransform'); return; }
    gl.useProgram(this._program);
    if (this._useVAO) this._vaoExt && this._vaoExt.bindVertexArrayOES(this._vao);
    else {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
      gl.vertexAttribPointer(this._posAttr, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this._posAttr);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._tcBuf);
      gl.vertexAttribPointer(this._tcAttr, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this._tcAttr);
    }
    gl.uniformMatrix3fv(this._dt, false, displayTransform);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, yTexture);
    gl.activeTexture(gl.TEXTURE0 + 6);
    gl.bindTexture(gl.TEXTURE_2D, uvTexture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this._useVAO) this._vaoExt && this._vaoExt.bindVertexArrayOES(null);
    this._renderFail = 0;
  },

  _onRenderFail(msg) {
    this._renderFail = (this._renderFail || 0) + 1;
    if (this._renderFail === 30) {
      this.setData({ statusText: '渲染异常：' + msg + '（需真机调试，模拟器不支持 VK）' });
      console.error('[VK] render fail 30x:', msg);
    }
  },

  _fallbackSim(reason) {
    this.setData({ poseState: 'sim', inFrame: true, statusText: '已切仿真（' + reason + '）' });
    if (this._simTimer) return;
    let t = 0;
    this._simTimer = setInterval(() => {
      // 页面已卸载/切后台时自行熄火，避免定时器带着 setData 打在已销毁页面上
      if (!this._pageAlive || !this.counter) { clearInterval(this._simTimer); this._simTimer = null; return; }
      t += 0.18;
      const y = 0.6 + 0.18 * Math.sin(t);
      if (this.data.isRunning && this.data.phase === 'running') {
        const r = this.counter.update({ hip: y, ankle: y, knee: y, wrist: y, leg: y, shoulder: y, elbow: y }, Date.now());
        const p = {};
        if (r.counter !== this.data.counter) p.counter = r.counter;
        if (r.status !== this.data.status) p.status = r.status;
        if (this.data.fps !== 20) p.fps = 20;
        for (const k in p) { this.setData(p); break; }
      }
    }, 50);
  },

  // —— 交互 ——
  // 说明：原「自由模式：待开始」的 handleStartFree 已移除。
  // 首页已提供「开始训练」入口，训练页再设一个按钮属重复操作；
  // 现三种模式统一为「进入训练页 → 5 秒准备倒计时 → 训练」，倒计时即是准备时间。

  // 暂停 / 继续（running 阶段）
  handlePause() {
    if (this.data.phase !== 'running') return;
    // 分组模式：判据是 groupRunning（休息段 isRunning 本来就是 false，
    // 用 isRunning 判会让「继续」按钮在休息时走进错误的恢复分支）
    if (this.data.isGroup) {
      if (this.data.groupRunning) {
        this._groupPause();
        this.setData({ groupRunning: false, isRunning: false, isPaused: true, statusText: '已暂停' });
      } else {
        this._groupResume();
      }
      return;
    }
    if (this.data.isRunning) {
      this._stopTimed();
      this._stopElapsed();
      this.setData({ isRunning: false, isPaused: true, statusText: '已暂停' });
    } else {
      this.setData({ isRunning: true, isPaused: false, statusText: '训练中' });
      this._startElapsed();
      if (this.data.mode === 'timed') this._startTimed();
    }
  },

  // 停止 / 结束（任何模式）→ 结果
  handleStop() {
    if (this.data.phase !== 'running') return;
    this._finish();
  },

  // 再来一次（同配置重置）—— 四种模式统一：重置后立即走 5 秒准备倒计时
  restart() {
    voice.unlock(); // 用户手势内静音解锁音频
    this.counter.reset();
    this._stopTimed();
    this._stopGroupTimer();
    this._stopElapsed();
    this._stopPrep();
    this.setData({
      counter: 0,
      elapsed: 0,
      elapsedStr: '00:00',
      totalSeconds: this.data.duration,
      timeStr: fmtTime(this.data.duration),
      isRunning: false,
      isPaused: false,
      statusText: '准备中…',
      phase: 'prep',
      // 分组会话复位（_startGroupSession 会再兜一次，这里先清掉避免结果页残留）
      groupRunning: false, groupResting: false, groupPhase: '', groupNo: 1,
      groupRestNum: this.data.groupRest, groupRestStr: fmtTime(this.data.groupRest),
    });
    if (!this.session && !this.data.needAuth) this.initVK();   // _finish 里已释放相机，再来一次时重新拉起
    this._startPrep();
  },

  backHome() {
    wx.navigateBack({
      delta: 1,
      fail: () => { wx.redirectTo({ url: '/pages/home/home' }); },
    });
  },

  toggleDebug() {
    const next = !this.data.showDebug;
    this.setData({ showDebug: next });
    if (!next) this.setData({ debugPoints: [] });
    if (this.counter && this.counter.setDebugMode) this.counter.setDebugMode(next);
  },

  // 绳子旋转像素采样（多信号门禁的 ROPE 信号）。仅跳绳模式、运行中、且 getCameraBuffer 可用时启用。
  _maybeSampleRope(frame) {
    if (this._ropeUnsupported) return;   // 已确认不支持：彻底停手，不再每帧 try/catch
    if (this.data.sport !== 'rope') return;
    if (!this.data.isRunning || this.data.phase !== 'running') return;
    if (!this.counter || !this.counter.feedRope) return;
    if (this._ropeFrame == null) this._ropeFrame = 0;
    this._ropeFrame++;
    if (this._ropeFrame % 6 !== 0) return; // 节流到 ~5fps，降低像素分配开销
    if (!frame.getCameraBuffer) { this._ropeUnsupported = true; return; }
    try {
      const W = 160, H = 160; // 16 倍数
      const buf = frame.getCameraBuffer(W, H);
      if (!buf) { this._ropeMiss = (this._ropeMiss || 0) + 1; if (this._ropeMiss > 10) this._ropeUnsupported = true; return; }
      const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (view.length < W * H * 4) { this._ropeUnsupported = true; return; }
      this._sampleRope(view, W, H);
    } catch (e) {
      // 老基础库 / 部分机型不支持 getCameraBuffer：一次失败即永久放弃 ROPE 信号
      this._ropeUnsupported = true;
      console.warn('[rope] getCameraBuffer 不可用，已关闭绳索信号:', e && e.message);
    }
  },

  _sampleRope(buf, W, H) {
    // 取画面下中部条带（绳在体前地面附近扫过区域），算灰度 std + 帧间均值差 → 绳子旋转度量
    const y0 = (0.5 * H) | 0, y1 = (0.8 * H) | 0;
    let sum = 0, n = 0; const rowMeans = [];
    for (let y = y0; y < y1; y++) {
      let rs = 0, rn = 0;
      const off = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = off + x * 4;
        rs += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
        rn++;
      }
      const m = rs / rn; rowMeans.push(m); sum += m; n++;
    }
    const mean = sum / n;
    let v = 0; for (const m of rowMeans) v += (m - mean) * (m - mean);
    const std = Math.sqrt(v / n);
    let dMean = 0;
    if (this._ropePrevMean != null) dMean = Math.abs(mean - this._ropePrevMean);
    this._ropePrevMean = mean;
    // 绳子旋转度量：条带对比度（绳线出现）+ 帧间运动（绳掠过）
    const metric = std + 0.5 * dMean;
    const HI = 16, LO = 9; // 阈值参照文章「绳线 std>18.5」精神，按条带局部对比度下调
    if (!this._ropeActive && metric > HI) {
      this._ropeActive = true;
      this.counter.feedRope(Date.now());
    } else if (this._ropeActive && metric < LO) {
      this._ropeActive = false;
    }
  },

  onSens(e) {
    const lv = parseInt(e.currentTarget.dataset.lv, 10) || 3;
    this.counter.setSensitivity(lv);
    this.setData({ sensitivity: lv });
  },
  onVotes(e) {
    const n = parseInt(e.currentTarget.dataset.lv, 10) || 3;
    this.counter.setMinVotes(n);
    this.setData({ minVotes: n });
  },
  handleReset() {
    this.counter.reset();
    if (this._beatTimer) { clearTimeout(this._beatTimer); this._beatTimer = null; }
    this.setData({ counter: 0, status: 'DOWN', statusText: '已重置', countBeat: false });
  },

  // —— Canvas 分享卡片绘制 ——
  // 版式复刻原型 shareOverlay()：白底圆角卡 + 品牌橙头部（运动名 / 大数字 / 日期）
  // + 两格数据（用时 · 个/分）+ 页脚条（品牌名 + 品牌色方块）。
  // 原型卡片 DOM 实测 303×244（正好 5:4），这里取 2× 绘制 —— 本函数里所有坐标与字号
  // 除以 2 即可与原型实测值逐项对照；改版式时同步跑 tools/_probe_sharecard.js 重量。
  // 刻意不画装饰圈与底部短线：原型那张卡没有，分享图不该比设计稿多出元素。
  _drawShareCard() {
    const query = wx.createSelectorQuery();
    query.select('#shareCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!this._pageAlive) return;  // 页面可能在 canvas 查询期间被卸载
        if (!res || !res[0] || !res[0].node) {
          console.warn('[share] canvas not ready, will retry on share tap');
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const K = 2;
        const W = 303 * K, H = 244 * K;
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);

        const d = this.data;
        const c = d.resultCount;
        const elapsed = d.resultElapsed || 0;
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        const sportName = (d.sport === 'volleyball' ? '垫排球' : '跳绳') + '训练';
        const now = new Date();
        const dateStr = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
        // 个 / 分：用时不足 1 秒时无意义，按 0 处理（原型那里写死 95 是演示占位，真机不能编数）
        const vpm = elapsed >= 1 ? Math.round(c / (elapsed / 60)) : 0;

        const PAD = 16 * K;      // 卡片左右内边距（原型 16px）
        const HEAD_H = 144 * K;  // 橙头高（原型 144px）
        const FOOT_H = 37 * K;   // 页脚高（原型 37px）
        const BRAND = '#FF4E2A';

        // 圆角矩形路径（仅页脚品牌色方块用；canvas 的 roundRect 基础库支持不全，手写更稳）
        const rr = (x, y, w, h, r) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.arcTo(x + w, y, x + w, y + h, r);
          ctx.arcTo(x + w, y + h, x, y + h, r);
          ctx.arcTo(x, y + h, x, y, r);
          ctx.arcTo(x, y, x + w, y, r);
          ctx.closePath();
        };

        // 1) 白底卡片。导出图保持矩形直角：微信侧会给图片消息自己加圆角，
        //    而 jpg 没有透明通道 —— 在画布上画圆角只会换来四个黑角。
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 2) 品牌橙头部（原型是纯色，不带渐变）
        ctx.fillStyle = BRAND;
        ctx.fillRect(0, 0, W, HEAD_H);

        // 3) 运动名
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `${12 * K}px sans-serif`;
        ctx.fillText(sportName, W / 2, 28.5 * K);

        // 4) 大数字 + 「个」：量宽后整体居中（勿按字数估宽，位数一变就偏）
        ctx.font = `bold ${52 * K}px sans-serif`;
        const nw = ctx.measureText(String(c)).width;
        ctx.font = `${13 * K}px sans-serif`;
        const uw = ctx.measureText('个').width;
        const gap = 3.25 * K;   // 原型里数字与「个」之间是一个 &nbsp;
        const startX = (W - (nw + gap + uw)) / 2;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${52 * K}px sans-serif`;
        ctx.fillText(String(c), startX, 70.5 * K);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `${13 * K}px sans-serif`;
        ctx.fillText('个', startX + nw + gap, 84 * K);

        // 5) 日期
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `${12 * K}px sans-serif`;
        ctx.fillText(dateStr, W / 2, 115.5 * K);

        // 6) 两格数据（用时 / 个·分）：值在上、标签在下，两格均分
        // 「最长连续」不画：小程序计数器没有这项统计，凭空编一个数比少画一格更糟。
        const stats = [['用时', `${mm}:${ss}`], ['个 / 分', String(vpm)]];
        // 在**内容区**（去掉左右内边距）里等分：原型三格区是 padding 16px 的 flex 容器，
        // 按整宽等分会让两格往外挪一截（实测格心该在 0.28 / 0.73，不是 0.25 / 0.75）。
        const cellW = (W - PAD * 2) / stats.length;
        stats.forEach((s, i) => {
          const cx = PAD + cellW * (i + 0.5);
          ctx.textAlign = 'center';
          ctx.fillStyle = '#1F2937';   // 原型 var(--ink)
          ctx.font = `bold ${14 * K}px sans-serif`;
          ctx.fillText(s[1], cx, 168 * K);
          ctx.fillStyle = '#9AA0A6';   // 原型 var(--ink3)
          ctx.font = `${10.5 * K}px sans-serif`;
          ctx.fillText(s[0], cx, 185.5 * K);
        });

        // 7) 页脚条：细分隔线 + 品牌名 + 品牌色方块
        const footTop = H - FOOT_H;
        ctx.beginPath();
        ctx.moveTo(0, footTop);
        ctx.lineTo(W, footTop);
        ctx.strokeStyle = '#F0F0F0';   // 原型 var(--line)
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#6B7280';     // 原型 var(--ink2)
        ctx.font = `${11.5 * K}px sans-serif`;
        ctx.fillText('会有时计数器', PAD, footTop + 19 * K);

        const sq = 15 * K;
        ctx.fillStyle = BRAND;
        rr(W - PAD - sq, footTop + 19 * K - sq / 2, sq, sq, 5 * K);
        ctx.fill();

        // 9) 导出为临时文件
        // ★ destWidth/destHeight 按**设备像素**给：W/H 是「设计坐标的 2×」逻辑单位
        //   （606×488），画布物理分辨率是 W*dpr。原先写成 destWidth: W 会把画面压到 1/3，
        //   而预览/朋友圈按 1000+ 设备像素展示 → 被放大后字发虚
        //   （模拟器 dpr=2 接近 1:1，所以只有真机上看得出来）。
        const that = this;
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: W, height: H,
          // 截取区域用逻辑单位（= canvas 的绘制坐标系），输出尺寸取**画布物理分辨率**
          // （canvas.width 就是上面设的 W*dpr），两边 1:1 不重采样。
          destWidth: canvas.width, destHeight: canvas.height,
          // 白底 + 橙头 + 文字：PNG 无损，笔画边缘不会像 jpg 那样被糊；平色图 PNG 也更小。
          fileType: 'png',
          success: (res) => {
            if (!that._pageAlive) return;  // 结果页上点了"返回首页"→页面已卸载
            that.setData({ shareCardPath: res.tempFilePath });
            that._shareCardPath = res.tempFilePath;
            console.log('[share] card image ready:', res.tempFilePath);
          },
          fail: (err) => {
            console.error('[share] canvasToTempFilePath failed:', err);
          },
        });
      });
  },

  // —— 分享至好友 ——
  onShareAppMessage() {
    const card = this._shareCardPath || this.data.shareCardPath;
    const title = this.data.shareTitle || '会有时计数器';
    return {
      title,
      path: '/pages/home/home',
      imageUrl: card || '',
      promise: new Promise((resolve) => {
        if (!card) {
          setTimeout(() => {
            this._drawShareCard();
            setTimeout(() => {
              resolve({
                title,
                path: '/pages/home/home',
                imageUrl: this._shareCardPath || this.data.shareCardPath || '',
              });
            }, 800);
          }, 100);
        } else {
          resolve({ title, path: '/pages/home/home', imageUrl: card });
        }
      }),
    };
  },

  // —— 分享至朋友圈 ——
  onShareTimeline() {
    const title = this.data.shareTitle || '会有时计数器';
    const card = this.data.shareCardPath;
    return {
      title,
      query: '',
      imageUrl: card || '',
    };
  },

  // 截图分享：生成成绩卡片后，弹出微信原生「分享图片」菜单
  // 菜单自带：发送给朋友 / 分享到朋友圈 / 收藏 / 保存图片 / 转发为贴图
  // needShowEntrance 会在图上嵌入小程序入口，好友/朋友圈点入口即可进入小程序。
  shareByImage() {
    const card = this._shareCardPath || this.data.shareCardPath;
    if (!card) {
      wx.showLoading({ title: '生成分享卡片...' });
      this._drawShareCard();
      const check = () => {
        const p = this._shareCardPath || this.data.shareCardPath;
        if (p) { wx.hideLoading(); this._openShareImageMenu(p); }
        else { wx.hideLoading(); wx.showToast({ title: '卡片生成失败', icon: 'none' }); }
      };
      setTimeout(check, 1500);
      return;
    }
    this._openShareImageMenu(card);
  },

  _openShareImageMenu(imagePath) {
    // wx.showShareImageMenu 基础库 2.13.0+：弹起微信原生分享图片菜单（含朋友圈入口）
    if (typeof wx.showShareImageMenu === 'function') {
      wx.showShareImageMenu({
        path: imagePath,
        needShowEntrance: true,
        entrancePath: 'pages/home/home',
        success: () => { /* 用户完成操作，无需额外处理 */ },
        fail: (err) => {
          console.warn('[share] showShareImageMenu failed:', err);
          wx.showToast({ title: '当前版本不支持该分享方式', icon: 'none' });
        },
      });
    } else {
      wx.showToast({ title: '当前版本不支持该分享方式', icon: 'none' });
    }
  },

  // 手动对焦：取景框点击显示对焦环动画（VisionKit 无对焦 API，仅视觉反馈）
  handleTapFocus(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this.setData({ showFocus: true, focusX: touch.x - 40, focusY: touch.y - 40 });
    clearTimeout(this._focusTimer);
    this._focusTimer = setTimeout(() => this.setData({ showFocus: false }), 900);
  },
});
