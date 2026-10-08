// workers/skipPose.js
// 微信小程序 Worker：在子线程运行 MoveNet 姿态估计，主线程只接收关键点坐标。
//
// 依赖（需 npm 安装并在微信开发者工具中“构建 npm”，详见 docs/跳绳AI计数接入说明.md）：
//   @tensorflow/tfjs-core
//   @tensorflow/tfjs-backend-webgl
//   @tensorflow-models/movenet
//
// 若上述依赖未构建 / 模型不可用，Worker 会自动进入“仿真模式”，
// 仅生成髋部 Y 的正弦振荡，保证主线程计数链路在无模型时也能跑通。

let tf = null;
let movenet = null;
let model = null;
let backendReady = false;
let useSimulate = false;

// 生产建议：把 MoveNet 模型自托管到自有备案域名，再填入此处；
// 留空则使用 tfjs 默认 tfhub 地址（需把 tfhub.dev / storage.googleapis.com 加入 request 合法域名）。
const MOVE_NET_MODEL_URL = '';

// 仿真：生成「身高归一化髋部特征」的正弦振荡，用于无模型时验证计数链路。
// 幅度需明显大于 minStd(0.008)，否则状态机不会触发。
let simT = 0;
function simulateFeature() {
  simT += 0.12;
  // 归一化特征约 0.5 上下、振幅 0.15（远大于 minStd），可稳定计数
  const v = 0.5 + 0.15 * Math.sin(simT);
  return { leftHipY: v, rightHipY: v };
}

// 低通平滑(EMA)状态：消除关键点抖动，与离线测试 sa=0.3 一致
const SMOOTH_ALPHA = 0.3;
let emaL = null;
let emaR = null;
function smooth(v, prev) {
  return prev == null ? v : prev + SMOOTH_ALPHA * (v - prev);
}

// COCO 关键点索引（MoveNet SINGLEPOSE 返回 17 点）
const IDX = { SHOULDER_L: 5, SHOULDER_R: 6, HIP_L: 11, HIP_R: 12, ANKLE_L: 15, ANKLE_R: 16 };

// 把像素级关键点转成「身高归一化」髋部特征（与 bench_skip_video.py 严格一致）
function normalizedHips(kp, width, height) {
  const shL = kp[IDX.SHOULDER_L], shR = kp[IDX.SHOULDER_R];
  const hipL = kp[IDX.HIP_L], hipR = kp[IDX.HIP_R];
  const ankL = kp[IDX.ANKLE_L], ankR = kp[IDX.ANKLE_R];
  if (!(shL && shR && hipL && hipR && ankL && ankR)) return null;
  const shMid = ((shL.y + shR.y) / 2) / height;
  const ankMid = ((ankL.y + ankR.y) / 2) / height;
  const bodyH = Math.max(1e-3, ankMid - shMid); // 踝中线 - 肩中线 = 身高(归一化)
  return {
    hipLn: (hipL.y / height - shMid) / bodyH,
    hipRn: (hipR.y / height - shMid) / bodyH,
  };
}

// 加载超时阈值（毫秒）：模型下载/后端初始化一旦挂起（如国内访问 tfhub 被墙、
// 未勾「不校验合法域名」被拦截、Worker 内 WebGL 不可用），必须在超时后主动回退仿真，
// 否则前端会永久卡在「模型加载中」。
const INIT_TIMEOUT_MS = 12000;

async function initTf() {
  if (backendReady) {
    wx.postMessage({ type: 'ready' });
    return;
  }

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    useSimulate = true;
    wx.postMessage({
      type: 'simulate',
      reason: '模型加载超时（可能网络无法访问 tfhub，或 Worker 内 WebGL 不可用）',
    });
  }, INIT_TIMEOUT_MS);

  try {
    tf = require('@tensorflow/tfjs-core');
    require('@tensorflow/tfjs-backend-webgl');
    movenet = require('@tensorflow-models/movenet');

    await tf.setBackend('webgl');
    await tf.ready();

    model = await movenet.load(movenet.SINGLEPOSE_LIGHTNING, {
      modelUrl: MOVE_NET_MODEL_URL || undefined,
    });

    if (settled) return; // 已超时转仿真，丢弃后续就绪消息，避免状态回切
    settled = true;
    clearTimeout(timer);
    backendReady = true;
    wx.postMessage({ type: 'ready' });
  } catch (e) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // 模型/依赖不可用：进入仿真模式，保证链路可测
    useSimulate = true;
    wx.postMessage({
      type: 'simulate',
      reason: String((e && e.message) || e),
    });
  }
}

async function infer(frame) {
  if (useSimulate) {
    const h = simulateFeature();
    emaL = smooth(h.leftHipY, emaL);
    emaR = smooth(h.rightHipY, emaR);
    wx.postMessage({
      type: 'pose',
      leftHipY: emaL,
      rightHipY: emaR,
    });
    return;
  }
  if (!backendReady || !model) return;

  try {
    const { data, width, height } = frame;
    const rgba = new Uint8Array(data);
    // 剥离 Alpha 通道：tfjs 在 Worker 内无 DOM，直接从像素构造张量
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const input = tf.tensor3d(rgb, [height, width, 3]);
    const poses = await model.estimatePoses(input, {
      flipHorizontal: false,
    });
    tf.dispose(input);

    if (poses && poses[0] && poses[0].keypoints) {
      const nh = normalizedHips(poses[0].keypoints, width, height);
      if (nh) {
        emaL = smooth(nh.hipLn, emaL);
        emaR = smooth(nh.hipRn, emaR);
        wx.postMessage({
          type: 'pose',
          leftHipY: emaL, // 身高归一化 + EMA 平滑后的髋部特征
          rightHipY: emaR,
        });
        return;
      }
    }
    wx.postMessage({ type: 'pose', leftHipY: null, rightHipY: null });
  } catch (e) {
    wx.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
}

wx.onMessage(async (msg) => {
  if (!msg) return;
  if (msg.type === 'init') {
    await initTf();
  } else if (msg.type === 'frame') {
    await infer(msg.frame);
  } else if (msg.type === 'reset') {
    simT = 0;
    emaL = null;
    emaR = null;
  }
});
