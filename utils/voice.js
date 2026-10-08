// utils/voice.js —— 女声语音倒计时播放
//
// 资源：assets/voice/ 下 31 个 MP3 ——
//   count_10..count_1 / start / time_up / done（13 个）
//   + milestone_10..100（步长 10）+ milestone_200..900（步长 100）（18 个），共 31 个。
// 生成：tools/gen_voice.py 用 edge-tts（24kHz/48kbps）→ tools/optimize_assets.py
//   统一转码为「单声道 / 16kHz / 16kbps」，总体积从 223KB 降到 ~86KB。
//   ⚠️ 不能指望 edge-tts 直接出低码率：微软端点只接受 audio-24khz-48kbitrate-mono-mp3，
//   其它格式一律 NoAudioReceived（实测见 tools/_probe_voice_bitrate.py）→ 只能本地 ffmpeg 转。
//   ⚠️ 文件名与后缀是代码拼出来的（name + '.mp3'），换码率**不要**同时换后缀。
//   报数片段都是短促单词（最长 ~0.9s），16kbps 属电话级码率，可懂度足够。
//
// 播放策略（修复“语音不响”的几处关键点）：
// 1) 代码包内资源必须用「相对路径（无前导斜杠）」assets/voice/... 引用；
//    原代码写成 /assets/voice/...（被当成设备根目录）导致文件永远找不到 → 静默不播。
// 2) 首次播放把 MP3 从代码包拷贝到 wx.env.USER_DATA_PATH（用户目录）后播放，
//    跨机型最稳；拷贝失败则直接播代码包相对路径，两者互为兜底（ensureCopied 必须被调用）。
// 3) 关键：obeyMuteSwitch = false —— 手机静音 / 震动模式下面倒计时语音也要响，
//    否则 iPhone 静音键打开时系统会直接压住音频而“不响”。
// 4) 每次播放新建一个 InnerAudioContext（播完即销毁），避免复用同一上下文在快速
//    连续倒计时时抢音 / 丢音。
// 5) unlock()：在用户手势内调用一次，静音播一个极短音频“解锁”音频后端
//    （volume=0，仍走完整音频管线），保证后续（即使在异步回调 / 定时器里）的
//    倒计时语音都能正常出声。**必须静音**：早期播 count_1 会多响一声「一」。

const NAMES = [];
for (let n = 10; n >= 1; n--) NAMES.push('count_' + n);
NAMES.push('start', 'time_up', 'done');
// 策略C 里程碑报数：10..100 步长10 + 200..900 步长100 的整句片段
for (let n = 10; n <= 100; n += 10) NAMES.push('milestone_' + n);
for (let n = 200; n <= 900; n += 100) NAMES.push('milestone_' + n);

let ensured = false;
let optionSet = false;
let current = null;   // 当前正在播的 InnerAudioContext（供打断）

// 全局兜底：所有 InnerAudioContext 默认静音键也播（部分机型仅设实例属性不生效）
function setMuteOption() {
  if (optionSet) return;
  optionSet = true;
  if (typeof wx !== 'undefined' && wx.setInnerAudioOption) {
    try {
      wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true });
    } catch (e) { /* ignore */ }
  }
}

// 把代码包内 MP3 拷贝到用户目录，仅执行一次
function ensureCopied() {
  if (ensured) return;
  ensured = true; // 先置位，避免拷贝异常时反复扫描
  if (typeof wx === 'undefined' || !wx.getFileSystemManager || !wx.env) return;
  try {
    const fs = wx.getFileSystemManager();
    const base = wx.env.USER_DATA_PATH + '/voice';
    try { fs.mkdirSync(base, true); } catch (e) { /* 已存在 */ }
    for (const name of NAMES) {
      const dest = base + '/' + name + '.mp3';
      let exists = false;
      try { fs.accessSync(dest); exists = true; } catch (e) { exists = false; }
      if (!exists) {
        try {
          // 代码包内资源用相对路径（无前导斜杠）
          fs.copyFileSync('assets/voice/' + name + '.mp3', dest);
        } catch (e) { /* 拷贝失败 → 播放时回退代码包路径 */ }
      }
    }
  } catch (e) { /* ignore */ }
}

// 优先用户目录（拷贝成功的），否则回退代码包相对路径
function resolveSrc(name) {
  if (typeof wx !== 'undefined' && wx.env && wx.getFileSystemManager) {
    const userPath = wx.env.USER_DATA_PATH + '/voice/' + name + '.mp3';
    try { wx.getFileSystemManager().accessSync(userPath); return userPath; } catch (e) { /* 回退 */ }
  }
  return 'assets/voice/' + name + '.mp3';
}

// 单次播放：独立上下文，播完/出错即销毁。
// 传入 exclusive=true 时会先停掉「上一个正在播的语音」——用于里程碑报数：
// 若 10 的语音还没播完、20 的报数又到了，必须先停旧的，否则两段叠音。
// 传入 silent=true 时音量置 0：仍走完整音频管线（用于「解锁」音频后端），但完全不出声。
function playOne(name, exclusive, silent) {
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) return;
  if (exclusive) stopCurrent();
  const c = wx.createInnerAudioContext();
  c.obeyMuteSwitch = false; // 静音模式也播
  c.src = resolveSrc(name);
  if (silent) c.volume = 0; // 解锁用：出声会干扰倒计时（曾用 count_1 导致多报一个「1」）
  current = c;              // 记录当前上下文，供下一次 exclusive 打断

  // ⚠️ 两个必须条件，否则 Android 上会 native 崩溃（微信整体退出）：
  //   1) 幂等：onEnded / onStop / onError / 10s 兜底 会重复触发，
  //      对同一个 InnerAudioContext 二次 destroy 属于释放后使用；
  //   2) 异步：不能在 native 回调栈里同步 destroy 自己，必须挪到下一个宏任务。
  let disposed = false;
  let timer = null;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (current === c) current = null;
    setTimeout(() => { try { c.destroy(); } catch (e) { /* ignore */ } }, 0);
  };
  c.onEnded(cleanup);
  c.onStop(cleanup);
  c.onError(cleanup);
  try { c.play(); } catch (e) { cleanup(); return; }
  // 兜底：10s 后强制销毁（防止音频上下文永不释放）
  timer = setTimeout(cleanup, 10000);
}

// 停掉当前正在播的语音（里程碑报到新数字时打断旧报数）
function stopCurrent() {
  const c = current;
  current = null;
  if (!c) return;
  try { c.stop(); } catch (e) { /* ignore */ }
  // stop() 会触发 onStop → cleanup（幂等），这里不重复 destroy
}

function playFile(name, exclusive, silent) {
  if (typeof wx === 'undefined') return;
  setMuteOption();
  ensureCopied();
  try { playOne(name, exclusive, silent); } catch (e) { /* ignore */ }
}

// —— 策略C：里程碑报数 ——
// 把任意整数转成「可播放的片段名序列」。
//   10..100 整十/整百：直接命中预生成整句片段。
//   其它（如 110/230）：整百 + 整十 拼接（"一百" + "十"→ 听感接近"一百一十"，
//     虽不及整句自然，但 100+ 训练量罕见，可接受）。
//   无对应片段（如 150 的"五十"需 50 片段，有；但 1000+ 无）→ 返回空，调用方静默。
function milestoneParts(n) {
  if (!(n > 0)) return [];
  if (n === 100) return ['milestone_100'];
  if (n >= 200 && n % 100 === 0 && n <= 900) return ['milestone_' + n];
  if (n <= 100 && n % 10 === 0) return ['milestone_' + n];      // 10..100
  if (n > 100) {
    const h = Math.floor(n / 100) * 100;                        // 整百
    const t = n % 100;
    const parts = [];
    if (h === 100) parts.push('milestone_100');
    else if (h >= 200 && h <= 900) parts.push('milestone_' + h);
    else return [];
    if (t % 10 === 0 && t >= 10 && t <= 90) parts.push('milestone_' + t);
    else if (t !== 0) return parts;                             // 非整十非零：只报整百部分（保守）
    return parts;
  }
  return [];
}

// 顺序播放片段序列（每段 exclusive，播完自动接下一段）
function playParts(parts, idx) {
  const i = idx || 0;
  if (i >= parts.length) return;
  playFile(parts[i], true);
  // 估算当前片段时长：整句约 0.6s，留 700ms 间隔接下一段（简单可靠，不依赖 onEnded 时序）
  if (i + 1 < parts.length) setTimeout(() => playParts(parts, i + 1), 700);
}

module.exports = {
  // 在用户手势（bindtap）内调用一次，解锁音频后端，保证后续语音正常出声。
  // ⚠️ 必须静音：早期用 count_1 解锁，会先响一声「一」，与 5 秒倒计时的数字重复。
  unlock() { playFile('count_1', false, true); },
  playCount(n) { if (n >= 1 && n <= 10) playFile('count_' + n); },
  playStart() { playFile('start'); },
  playTimeUp() { playFile('time_up'); },
  playDone() { playFile('done'); },
  // 策略C：报里程碑总数（可打断上一段报数）
  playMilestone(n) {
    const parts = milestoneParts(n);
    if (!parts.length) return false;
    playParts(parts);
    return true;
  },
  // 供「倒数互斥」使用：停掉当前报数语音
  stopReport() { stopCurrent(); },
  _milestoneParts: milestoneParts,   // 导出供离线单测
};
