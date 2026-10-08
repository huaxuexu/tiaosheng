// utils/sensors.js —— 加速度计/设备传感器辅助信号采集（供 SkippingCounter 交叉验证）
// 
// 规则 I: Z轴触地尖峰    accel.z 突变 >3��均值 → 落地脉冲 → +0.5
// 规则 J: 三轴自由落体   合成量 <0.3 延续5帧 → 飞行段确认 → +0.5  
// 规则 K: 零穿频率检测   accel.z 归零后零穿 ∈[1.5,5]Hz → 正常 → +0.2 / 偏离 → -0.2
// 规则 L: 双模确认       关节fire+accel落地<100ms → +1.0
// 规则 W: 姿态角稳定      手机架拍时姿态稳定 → 信号可信
// 规则 X: 环境光突变      亮度骤变 → 放弃1s外部加成
// 规则 Y: 低电保护       电池<15% → 自动放宽minPeriod

const _st = {};

function start(onSpike) {
  if (_st.accelOK) return;
  try {
    wx.startAccelerometer({ interval: 'game' });
    wx.onAccelerometerChange((res) => {
      const { x, y, z } = res;
      _st.accel = { x, y, z, ts: Date.now(), mag: Math.sqrt(x*x + y*y + z*z) };

      // I: Z轴触地尖峰
      if (!_st.zHist) _st.zHist = [];
      _st.zHist.push(_st.accel.mag);
      if (_st.zHist.length > 25) _st.zHist.shift();
      if (_st.zHist.length >= 8) {
        let sum = 0; for (const v of _st.zHist) sum += v;
        const mean = sum / _st.zHist.length;
        // 尖峰阈值：>3×均值
        if (_st.accel.mag > mean * 3) {
          _st.spikeTs = _st.accel.ts;
          _st.spikeBoost = 0.5;
        }
      }

      // J + K: 自由落体/零穿
      if (!_st.zRaw) _st.zRaw = [];
      _st.zRaw.push(z);
      if (_st.zRaw.length > 30) _st.zRaw.shift();
      // 滑动均值归零
      if (_st.zRaw.length >= 15) {
        const avgZ = _st.zRaw.slice(-15).reduce((a,v)=>a+v,0)/15;
        _st.zNorm = z - avgZ;
        // J: 飞行段检测（合成量<0.3）
        if (_st.accel.mag < 0.3) { _st.freeFallFrames = (_st.freeFallFrames||0)+1; }
        else { _st.freeFallFrames = 0; }
        if (_st.freeFallFrames >= 5) _st.freeFallActive = true;

        // K: 零穿计数
        if (!_st.zNormHist) _st.zNormHist = [];
        _st.zNormHist.push(_st.zNorm);
        if (_st.zNormHist.length > 40) _st.zNormHist.shift();
        let zc = 0;
        for (let i = 1; i < _st.zNormHist.length; i++) {
          if (_st.zNormHist[i-1] * _st.zNormHist[i] < 0) zc++;
        }
        _st.zCrossHz = zc / (_st.zNormHist.length / 30); // Hz @30fps
      }
    });
    _st.accelOK = true;
  } catch(e) { /* noop */ }

  // W: 设备姿态
  try {
    wx.startDeviceMotionListening({ interval: 'ui' });
    wx.onDeviceMotionChange((res) => {
      _st.attitude = { pitch: res.pitch||0, roll: res.roll||0, ts: Date.now() };
    });
  } catch(e) { /* noop */ }
}

function stop() {
  try { wx.stopAccelerometer(); } catch(e) {}
  try { wx.stopDeviceMotionListening(); } catch(e) {}
  _st.accelOK = false;
}

// 每帧调用，返回本轮应注入的提升值
function getBoost(counter) {
  let boost = 0;

  // I: 落地尖峰（200ms有效期）
  if (_st.spikeTs && Date.now() - _st.spikeTs < 200) { boost += _st.spikeBoost; _st.spikeBoost = 0; }

  // J: 飞行段确认
  if (_st.freeFallActive) { boost += 0.5; _st.freeFallActive = false; _st.freeFallFrames = 0; }

  // K: 零穿频率在正常范围
  if (_st.zCrossHz != null && _st.zCrossHz >= 1.5 && _st.zCrossHz <= 5) boost += 0.2;

  // W: 姿态稳定减权
  if (_st.attitude) {
    if (!_st.prevAtt) _st.prevAtt = _st.attitude;
    const dPitch = Math.abs(_st.attitude.pitch - (_st.prevAtt.pitch||0));
    const dRoll = Math.abs(_st.attitude.roll - (_st.prevAtt.roll||0));
    if (dPitch > 15 || dRoll > 15) boost -= 0.3; // 手机在手中晃动
    _st.prevAtt = _st.attitude;
  }

  // Y: 低电保护 (每30次计数检查一次)
  if (counter % 30 === 0 && !_st.batteryOK) {
    try {
      wx.getBatteryInfo({ success: (res) => {
        _st.lowPower = res.level <= 0.15 && !res.isCharging;
        _st.batteryOK = true;
      }});
    } catch(e) {}
  }

  return boost;
}

// L: 双模确认——调用方给定jointFireTs，若accel有尖峰且时间差<100ms → +1.0
function dualConfirm(jointFireTs) {
  if (_st.spikeTs && Math.abs(_st.spikeTs - jointFireTs) < 100) { _st.spikeTs = 0; return 1.0; }
  return 0;
}

function isLowPower() { return _st.lowPower || false; }

module.exports = { start, stop, getBoost, dualConfirm, isLowPower };
