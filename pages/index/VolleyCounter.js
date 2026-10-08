// pages/index/VolleyCounter.js
// 垫排球计数器（前臂垫球 / forearm bump 识别）。
//
// 动作分析：垫球时双臂前伸、小臂上抬接球，手腕随每次垫球出现一次
// 「上抬（Y 减小）→ 回落（Y 增大）」的完整上下，与跳绳「离地→落地」同构，
// 故复用单方向周期检测器（见 _channelUpdate）。
//
// ⚠️ 仍属「真机调参阶段」：算法结构已完整、可直接使用，但最佳阈值需在你
// 真机上用训练页「调试」面板校准（调 敏感度 / 票数 两个滑块即可）。
// 若某通道幅度长期 < 0.05，多半是 BODY_IDX 关节点索引映射不对，请先用
// 调试浮层核对 VisionKit 的「腕/肘」点是否对应垫球动作。
//
// 通道：wrist（双腕平均竖向位置，相对身高校正）、elbow（双肘，冗余确认）。
// 融合：≥ minVotes 个不同通道在同一 voteWindow 内触发即计 1 次。

class VolleyCounter {
  constructor(options) {
    options = options || {};
    this.maxHistoryLen = options.maxHistoryLen || 20;
    this.minStd = options.minStd != null ? options.minStd : 0.004;
    this.kUp = options.kUp != null ? options.kUp : 0.6;
    this.kDown = options.kDown != null ? options.kDown : 0.2;
    this.featureAlpha = options.featureAlpha != null ? options.featureAlpha : 0.3;
    this.minPeriodMs = options.minPeriodMs != null ? options.minPeriodMs : 220;
    this.minVotes = options.minVotes != null ? options.minVotes : 1;
    this.voteWindow = options.voteWindow != null ? options.voteWindow : 400;
    this.channels = ['wrist', 'elbow'];
    this.debug = this._emptyDebug();
    this.reset();
  }

  _emptyDebug() {
    const d = { votes: 0, state: 'DOWN' };
    for (const c of this.channels) d[c] = { amp: 0, std: 0, state: '中' };
    return d;
  }

  // 灵敏度档位：1=最严（需大幅度） → 5=最松（小幅也计）。
  // 垫球手腕幅度通常小于跳绳髋部，默认建议 3~5，真机按需调。
  setSensitivity(level) {
    const t = Math.max(0, Math.min(1, (level - 1) / 4));
    this.minStd = 0.008 - 0.0065 * t; // 1→0.008  5→0.0015
    this.kUp = 0.8 - 0.4 * t;         // 1→0.80   5→0.40
    this.kDown = 0.20;                // 回落门限保持浅，保证计到
  }

  setMinVotes(n) {
    n = Math.round(Number(n));
    if (!(n >= 1)) n = 1;
    if (n > this.channels.length) n = this.channels.length;
    this.minVotes = n;
  }

  // 与 SkippingCounter 保持同一接口（index.js 通用训练页会无条件调用这两个方法）
  setMinPeriod(ms) {
    const v = Number(ms);
    if (isFinite(v) && v > 0) this.minPeriodMs = v;
  }

  setDebugMode(on) { this._debugMode = !!on; }

  reset() {
    this.counter = 0;
    this.status = 'DOWN';
    this.frame = 0;
    this._ch = {};
    this._fires = [];
    this._lastGlobalTs = -1e9;
  }

  // 出框 / 跟踪中断时的重置：清通道跟踪态但**保留已计数量**。
  // 与 reset() 的区别只有一点：不动 counter。训练中途人体短暂出框只该暂停计数，
  // 不该把已经垫到的个数清零（与 SkippingCounter.resetTrackingKeepCount 同名同语义）。
  resetTrackingKeepCount() {
    this._ch = {};              // 通道基线/历史/武装态全部作废，回框后重新收敛
    this._fires = [];           // 清掉未结算的投票
    this._lastGlobalTs = -1e9;  // 解除冷却，回框即可继续计
  }

  _getCh(n) {
    if (!this._ch[n]) this._ch[n] = { fSm: null, hist: [], armed: null, lastTs: -1e9 };
    return this._ch[n];
  }

  _amp(ch) {
    if (ch.hist.length < 2) return 0;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < ch.hist.length; i++) {
      if (ch.hist[i] < mn) mn = ch.hist[i];
      if (ch.hist[i] > mx) mx = ch.hist[i];
    }
    return mx - mn;
  }

  _stdOf(ch) {
    if (ch.hist.length < 2) return 0;
    const len = ch.hist.length;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += ch.hist[i];
    const avg = sum / len;
    let sq = 0;
    for (let i = 0; i < len; i++) { const d = ch.hist[i] - avg; sq += d * d; }
    return Math.sqrt(sq / len);
  }

  // 单方向周期检测：fSm 先下穿 armLine（手腕抬到高位）→ 再上穿 countLine（回落）→ 计 1 次
  _channelUpdate(ch, raw, ts) {
    if (ch.fSm == null) ch.fSm = raw;
    else ch.fSm = this.featureAlpha * raw + (1 - this.featureAlpha) * ch.fSm;
    ch.hist.push(ch.fSm);
    if (ch.hist.length > this.maxHistoryLen) ch.hist.shift();
    if (ch.hist.length < this.maxHistoryLen) return false; // 等窗口填满再判定，避免起手误计
    const len = ch.hist.length;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += ch.hist[i];
    const avg = sum / len;
    let sq = 0;
    for (let i = 0; i < len; i++) { const d = ch.hist[i] - avg; sq += d * d; }
    const std = Math.sqrt(sq / len);
    if (std < this.minStd) { ch.armed = null; return false; } // 波动过小，视为静止
    const armLine = avg - this.kUp * std;   // 抬手位（Y 小）
    const countLine = avg + this.kDown * std; // 回落位（Y 大）
    let fired = false;
    if (ch.armed == null) {
      if (ch.fSm < armLine) ch.armed = 'UP'; // 手腕已抬到高位，进入 armed
    } else if (ch.armed === 'UP') {
      if (ch.fSm > countLine) {              // 手腕回落到低位 → 完成一次垫球
        if (ts - ch.lastTs >= this.minPeriodMs) { fired = true; ch.lastTs = ts; }
        ch.armed = null;
      }
    }
    return fired;
  }

  // features: { wrist, elbow }（归一化 Y，越小越靠上；缺测传 null 即忽略该路）
  update(features, ts) {
    this.frame += 1;
    if (ts == null) ts = this.frame * (1000 / 30);
    const firedThisFrame = [];
    let anyValid = false;
    for (const n of this.channels) {
      const v = features[n];
      if (v == null || isNaN(v)) continue;
      anyValid = true;
      const ch = this._getCh(n);
      if (this._channelUpdate(ch, v, ts)) firedThisFrame.push(n);
    }
    if (!anyValid) return { counter: this.counter, status: this.status };
    if (firedThisFrame.length) {
      for (const n of firedThisFrame) this._fires.push({ ts, ch: n });
      this._fires = this._fires.filter((f) => ts - f.ts <= this.voteWindow);
      const firedSet = new Set(this._fires.map((f) => f.ch));
      this.debug.votes = firedSet.size;
      if (firedSet.size >= this.minVotes && ts - this._lastGlobalTs >= this.minPeriodMs) {
        this.counter += 1;
        this._lastGlobalTs = ts;
        this._fires = [];
        this.status = 'UP';
      }
    }
    for (const n of this.channels) {
      const ch = this._ch[n];
      if (ch) this.debug[n] = { amp: this._amp(ch), std: this._stdOf(ch), state: ch.armed === 'UP' ? '抬' : '中' };
    }
    this.debug.state = this.status;
    return { counter: this.counter, status: this.status };
  }
}

module.exports = VolleyCounter;
