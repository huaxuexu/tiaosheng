// pages/index/SkippingCounter.js
// 跳绳计数（抗抖动 / 抗丢帧 · 多信号门禁 · 节律验证 · 人体尺度归一化）
//
// 检测核心：单特征（髋部绝对归一化 Y）+ 自适应基线 + 迟滞(hysteresis) + 节奏锁相 + 防卡死。
// 取代初版 6 通道投票状态机（上限 77%），以及第二版纯边沿计数（低帧率/丢帧下脆，真机实测 80%）。
//
// 门禁层（参考 CSDN 文章「三重门禁」思路，适配微信无 OpenCV 环境）：
//   一次有效跳跃须由「主信号 JUMP(髋)」触发候选，并由至少 (minVotes-1) 个辅助信号在同步窗口内协同确认。
//   辅助信号：
//     - ARM   腕部垂直运动迟滞检测（手臂摆动）
//     - FOOT  踝部垂直运动迟滞检测（脚离地）
//     - ACCEL 髋部加速度二阶差分尖峰（起跳加速度拐点）
//     - ROPE  绳子旋转像素检测（来自 index.js 的 getCameraBuffer 条带灰度，经 feedRope 喂入）
//   minVotes(1..4)：最少「同意信号总数(含跳)」。默认 2 = 跳 + 任一辅助（兼顾精度的同时不丢真跳）。
//   sens(1..5)：除控制 JUMP 迟滞带外，另映射为同步窗口 syncWindowMs（敏感度越高窗口越窄、协同要求越严）。
//
// 关键改进（针对真机 VisionKit 姿态退化）：
//   1. 自适应周期 minPeriod：用最近若干次间隔的中位数估计真实节奏，不再写死 250ms。
//   2. 防卡死恢复：距上次计数超过约 1.6×近期周期，放宽触发条件兜底。
//   3. ≤2 帧短丢帧插值：起跳谷底跟丢时 hold 上一有效值，避免整跳丢失。
//   4. 边沿去抖：需连续 2 帧低于阈值才记一次起跳，抑制 VisionKit 高频噪声假边沿。
//   5. 优雅降级：若全程无任何辅助信号触发（如离线 bench 仅喂 hip），则 minVotes 视作 1，门禁不生效，行为与旧版一致。
//
// 2026-09-10 借鉴同类开源项目（GitHub: mayask/opencv-rope-jump-counter、jerryli1835/Counting-Sports、
// chenwr727/RopeSkippingCounter）新增三层鲁棒性，均可用 options 关闭以便回归：
//   P0 节律验证门（rhyEnabled）：跳绳是稳定节律运动——用「连续 K 次起跳的间隔一致性 + 合理跳频区间」
//      作为计数总闸门；走动/晃绳/单次抖动形不成稳定节律 → 天然被拒（纯时序，不依赖附加传感器）。
//   P1 人体尺度归一化 + 窗口极值基线：
//      P1a 全部绝对阈值乘以 sc = 实时人体尺度/基准尺度，实现距离无关（离得远/近不再漏计/误计）；
//      P1b 用滑动窗口的 max/min 得到动态上下界与相对比例切换线（起跳 35%、落地 55%）。
//   P2 鲁棒性：抗换人（帧间髋 Y 突变忽略）、检测中断全重置、X 轴水平稳定性门（走动时暂停计数）。
//
// 2026-09-13 新增「方案D：起跳上升幅度门 + 会话建立门」——目标 0 延迟 / 0 误差：
//   针对「点开始误计 1 个」与「静止/走动/晃绳误计」两类误报（mayask 开源用例 fp01/fp02）。
//   D1 rise 门   ：起跳上升幅度（滑动窗口稳健峰谷差 / 人体尺度）须落在合理区间 → 拒微抖与极端漂移。
//   D3 span 门   ：rise 窗口的「原始帧跨度」须接近窗口长度（检测连续）→ 拒「大量丢帧下把漂移当起跳」。
//   D4/D5 会话门 ：未建立会话时暂存 fire，检测到「相邻两 fire 间隔 ≤ fireConfirmMs」才建立会话并
//                  回补早段候选；建立后所有 fire 即时入账。孤立噪声（fire 之间隔 ≥2.6s）永不建立 → 0 误计。
//   标定工具：tools/validate_scenarios.js（权威：真实 100+fp01/fp02+合成孤立跳）、tools/regression_check.js
//                （21 个退化场景对照旧版）。成效：fp01=0、fp02=0、合成 0/20；真实 100±2；累计误差 199→169。
//   ⚠️ 已知取舍：会话「建立」需检测到节奏（约前 4s），故整个会话的首个计数会延迟到该时刻显示
//      （之前真实早段跳跃靠 D4 回补，计数不丢只是显示稍晚）；此后每跳均即时计数（稳态 0 延迟）。
//      这是「0 误差」与「首计 0 延迟」在信息上不可兼得的必然取舍（fp02 首个孤立 fire 与真实首跳
//      的 rise 完全重叠，只能靠「是否成串」区分，而成串判定天然需要等待第二拍）。
//
// 校验：test.mp4（真实 100 跳）离线全特征 100/100；hip-only 102；fp01/fp02/合成孤立跳均 0。
// 注意：离线校验用 MediaPipe 33 点姿态；线上为 VisionKit 23 点，分布有差异，上线前务必真机复测。

// —— 辅助信号迟滞检测器配置 ——
const ARM_OPTS = { k: 0.5, minBand: 0.012, maxBand: 0.4, minGap: 200, rising: true };
const FOOT_OPTS = { k: 0.5, minBand: 0.012, maxBand: 0.4, minGap: 200, rising: true };
const ACCEL_OPTS = { k: 0.5, minBand: 0.004, maxBand: 0.06, minGap: 200, rising: false };
// 肩/膝/腿 仅用于诊断面板振幅显示，不参与计数/门禁（沿用 _stepOsc 的 amp 跟踪即可）
const KNEE_OPTS = { k: 0.5, minBand: 0.01, maxBand: 0.4, minGap: 200, rising: true };
const LEG_OPTS = { k: 0.5, minBand: 0.01, maxBand: 0.4, minGap: 200, rising: true };
const SHOULDER_OPTS = { k: 0.5, minBand: 0.01, maxBand: 0.4, minGap: 200, rising: true };

// —— 门禁与检测阈值常量 ——
const PENDING_TIMEOUT_FACTOR = 2;    // 待裁决超时 = syncWindowMs 的倍数（给异步信号留余量）
const STUCK_PERIOD_RATIO = 1.6;      // 防卡死：距上次计数超过此倍近期周期时放宽触发
const STUCK_BAND_RATIO = 0.3;        // 防卡死模式下保留的迟滞带比例（避免下蹲误判）
const COOLING_PERIOD_RATIO = 0.55;   // 自适应冷却：取 0.55×近期周期(节奏快时放宽)与 minPeriodMs 的较小者
const HIP_FOOT_AMP = 0.008;          // FOOT 脚踝辅助信号：【髋振幅 & 脚踝瞬时偏离】双阈值
const FOOT_DEBOUNCE_MS = 200;        // FOOT 辅助信号去重间隔
const BASE_FAST_CONVERGE = 0.3;      // 基线快速收敛：偏差超过 st.amp 的这个比例时加速学习率
const BASE_FAST_ALPHA = 0.05;        // 基线快速收敛 α
const BASE_SLOW_ALPHA = 0.02;        // 基线慢速收敛 α
const OSC_AMP_EMA = 0.97;            // _stepOsc 振幅 EMA 衰减
const OSC_AMP_ALPHA = 0.03;          // _stepOsc 振幅 EMA 学习率
const INTERVAL_BUF_SIZE = 8;         // 周期统计窗口大小
const PRUNE_PADDING_MS = 1500;       // 事件剪枝额外留白
const DEFAULT_FRAME_MS = 33.333;     // 1000/30，无 ts 时的默认帧间隔

// —— P1a：人体尺度基准（把绝对阈值相对化，实现距离无关）——
const REF_SCALE = 0.378;             // test.mp4 实测 bodyH 均值（归一化 Y），作比值换算基准
const SCALE_FALLBACK = 0.38;         // 无踝可测时的默认人体尺度
const SCALE_SH_HIP_K = 2.63;         // bodyH ≈ 2.63 × 肩髋距（实测）
const SCALE_EMA = 0.05;              // 人体尺度 EMA 学习率（抗单帧异常）
const SCALE_MIN = 0.15, SCALE_MAX = 1.0; // 尺度夹紧范围

// —— P1b：滑动窗口极值基线（参考 jerryli1835 / chenwr727）——
const WIN_LEN = 30;                  // 窗口长度（帧，≈1s@30fps）
const WIN_UP_RATIO = 0.35;           // 起跳线 = winMin + 0.35×dy（HIP Y 越小越高）
const WIN_DOWN_RATIO = 0.55;         // 落地线 = winMax - 0.55×dy（越小→落地线越高→越易漏计）
const WIN_ACTIVATE_RATIO = 0.03;     // 激活门：窗口振幅 dy > 0.03×scale 才启用窗口判定（静止无振荡时退回 EMA band）
const WIN_PCT = 0.10;                // 稳健极值分位（0=原始 min/max；0.10=取 10/90 分位，抗噪声尖峰）

// —— P0：节律验证门（参考 mayask/opencv-rope-jump-counter）——
// v2 修正（2026-09-10）：v1 用「均值 + 硬区间 [150,900] + 全间隔必须一致 + 无释放阀」，
//  在低帧率下检测间隔翻倍（fps=10 实测间隔≈1200ms > 900）→ 永远确认不了 → 计数恒为 0（灾难性）。
// v2 三处改造，保证「只延迟、不永久拒绝」：
//   1) 用「中位数 + 多数一致」替代「均值 + 全部一致」——单个离群间隔不再毒死整段判定；
//   2) 频率区间放宽到 [150,1500]，容纳低帧率下的间隔翻倍；
//   3) 释放阀 RHYTHM_GRACE：未确认但已累积 N 个候选 → 视为「节奏虽不完美但确在连续跳」，
//      接受并回补缓冲（最坏也只损失 <N 次早段计数，绝不归零）。
const RHYTHM_BUF = 12;               // 节律窗口：保留最近 12 次起跳时刻
const RHYTHM_CONFIRM = 4;            // 至少几个点（≥3 个间隔）才做严格一致性判定（调大=更严、启动延迟更长）
const RHYTHM_TOL = 0.6;              // 间隔一致性容差（|偏差|/中位）
const RHYTHM_MAJORITY = 0.7;         // 一致间隔占比阈值（≥70% 即确认）
const RHYTHM_GRACE = 6;              // 释放阀：未确认累积到此数 → 接受并回补（防空转归零；同时限定起跳前热身延迟 ≤6 跳）
const RHYTHM_MIN_MS = 150;           // 间隔下界（跳频上限 ≈6.7 跳/秒）
const RHYTHM_MAX_MS = 1500;          // 间隔上界（跳频下限 ≈0.67 跳/秒；旧 900 会在低帧率误杀）
const RHYTHM_GAP_FACTOR = 3.0;       // 节奏中断：间隔 > max(1.1×maxMs, 此倍中位) → 清空重来

// —— P2：鲁棒性（抗换人 / 丢失重置 / X 稳定性）——
const MAX_Y_JUMP_RATIO = 0.25;       // 帧间髋 Y 跳变 > 0.25×scale 视为换人/异常，忽略该帧
const MAX_IGNORE_STREAK = 5;         // 连续忽略超过此数 → 全重置重新锚定
const DET_GAP_RESET_MS = 1000;       // 检测中断判定下限（ms）；真正的「离开画面」间隔远大于此
const DET_GAP_K = 6;                 // 自适应倍数：gap > max(下限, K×近期帧间隔中位) 才判为中断
const X_WIN_LEN = 15;                // X 稳定性窗口（帧）
const X_DRIFT_RATIO = 0.30;          // X 窗口峰峰 > 0.30×scale 判为走动 → 暂停计数

// —— 方案A：冷启动/入场防误计（2026-09-13）——
// 背景：原实现有两处致命叠加——
//   ① reset() 把 _lastTs 置 -1e9，而 _lastTs 只在 _accept() 里推进；warm-up 期间不计数 →
//      _lastTs 永远是 -1e9 → warm-up 结束后第一帧 elapsed = ts+1e9 「必然」≥ minPeriodMs →
//      冷启动第一次越过阈值就被计入（即使只是入场站定的微晃）。这是「点开始误计 1 个」的根因。
//   ② warm-up 只按「帧数」，不校验是否真出现了跳跃幅度；且入场前倾/手机晃会被大 alpha 基线吸收，
//      使 amp 被喂大 → warm-up 一结束就极易被一个小摆动触发。
// 修复三件套：
//   A1 冷启动把「冷却起点」锚到真实时间：warm-up 期间持续推进 _lastTs（= 当前帧 ts），
//      使 warm-up 结束后的 elapsed 从真实的小值算起，冷却门恢复正常语义。
//   A2 warm-up 退出条件加「真振幅」：EMA 振幅 amp ≥ armActivateRatio×scale 才认为出现了真实跳跃。
//      用 amp（检测器自身迟滞带所依赖的 |偏差| EMA）而非窗口 winDy——winDy 走分位裁剪会显著低估，
//      实测真跳时 amp/scale≈0.026~0.035，而 winDy/scale 仅 0.012~0.03，用 winDy 会永远武装不了（计数归零）。
const ARM_ACTIVATE_RATIO = 0.020;    // A2：amp/scale > 0.020 认为「有真实跳跃动作」（真跳实测 p10≈0.026）
// A3 候选数：设为 1 —— 「真振幅门」（A2，amp≥0.020×scale）本身已能挡住静止微晃的误触发，
//   再要求攒多个候选只会推迟「首次计数」。离线实测（tools/diag_ab4.js）：
//     cf=3 → 冷启动首计数推迟到第 133 帧（≈4.0s），静止 2s 误计 0；
//     cf=1 → 冷启动首计数第 19 帧（≈1.6s，几乎与关守卫相当），静止 2s 误计仍为 0。
//   故取 1：防误计效果不变，灵敏度显著恢复。
const ARM_CONFIRM_FRAMES = 1;        // A3：武装前需出现的真实起跳候选数（1 = 首个真振幅起跳即武装）
const ARM_SILENCE_FRAMES = 3;        // A3：武装态确认后，前若干帧仍只跟踪不计数（安全静默）

// —— 方案B：晃动鲁棒性（2026-09-13）——
// B1 走动/晃动时不仅「暂停计数」，还要重置跟踪态（基线/窗口/节律），否则被晃动的 Y 数据污染基线，
//    晃动停止后会先蹦一个错误计数（对齐 mayask/opencv-rope-jump-counter 的 _reset_rhythm 做法）。
// B2 晃动常带 Y 分量（手机/人体晃动非纯水平位移），故 moving 判定除 X 漂移外再加「Y 基线漂移」：
//    |base - 近窗均值| > yDriftRatio×scale 也判为 moving（对齐 mayask 的 max_y_drift=20%）。
// B3 从 moving 恢复静止后，强制静默 recoverSilenceFrames 帧再允许计数（重新建立干净基线）。
const Y_DRIFT_RATIO = 0.20;          // B2：Y 基线漂移超过 0.20×scale 判为走动/晃动
const RECOVER_SILENCE_FRAMES = 4;    // B3：晃动恢复后的静默帧数

// —— 方案D：起跳上升幅度门（rise gate）+ 间隔门（gap gate）（2026-09-13）——
// 目标：0 延迟 + 0 误差。用真实数据（test.mp4 GT=100，mayask 误报用例 fp01/fp02 GT=0）标定。
//
// 诊断（tools/diag_clean.js，关掉全部守卫取「原始计数点」，rise = 近窗峰谷差 valley-peak）
// 的「归一化值」(rise/scale，scale=人体尺度≈0.378)：
//   真实跳绳 rise/scale 高度稳定：p10=0.080 p50=0.098 p90=0.112（即 97% 落在 [0.080,0.112]）。
//   仅开头 3~4 跳 rise/scale 偏小/偏大（0.020~0.134），属冷启动/首跳特例。
//   误报 rise/scale 完全落在两侧：
//     fp01 单次误计 rise/scale=0.230（远超真实上限）；
//     fp02 四次误计 rise/scale=0.032 / 0.135 / 0.157 / 0.553（3 个越界）。
//   → rise 是「一次完整起跳（落地低点→腾空最高点）的峰谷差」，比帧间速度稳定得多。
//     （帧间速度门已实测失败：收紧到能杀抖动时真跳绳也被杀，两者重叠。）
//
// ⚠️ 关键口径：rise 必须用「跨越起跳的滑动窗口」峰谷差，不能用「落地帧即时重置的周期峰谷」——
//   后者在触地帧会被重置为当前 y，导致 fire 时 rise 恒为 0（曾导致真跳 103→1 灾难性回归）。
//   现改用 _riseWin（近 RISE_WIN 帧髋 Y 环形窗），fire 时 rise = 峰谷差（稳健分位）。
// ⚠️ 单位口径：rise 是「绝对归一化 Y 值」，门限是 riseMinK×scale（无量纲比值×尺度）——
//   标定时务必用 rise/scale 的比值（见上），不要直接拿绝对 rise 当阈值（曾因此把真跳全拒）。
//
// 间隔门（gap）：真实跳绳计数间隔极稳定（test.mp4 10~12 帧）；误报是孤立点（间隔 78~346 帧）。
//   间隔 > gapMaxMs 的孤立计数一律不计——杀掉 fp01 的孤立误计与 fp02 的散乱误计。
//   ⚠️ 首次计数「不」受间隔门限制（无前序可比）→ 0 延迟；且首计数仍受 rise 门约束。
const RISE_WIN = 16;                 // D1：rise 计算的滑动窗口长度（帧，≈一个完整起跳周期@30fps）
const RISE_MIN_K = 0.025;            // D1：起跳上升幅度下限（rise/scale），低于视为微抖
                                     //   ⚠️ 标定重点：rise 是绝对振幅，会随「距离/跳幅」等比缩小（ampScale=0.6 时
                                     //   rise/scale 仅 0.052），故下限必须放宽到 0.025 才能不误杀远距离/小跳。
                                     //   误报的「隔离性」主要由 D4/D5 节奏门负责，D1 只兜底微抖与漂移。
const RISE_MAX_K = 0.300;            // D1：起跳上升幅度上限（rise/scale），高于视为换人/镜头突变/超大漂移。
                                     //   ⚠️ 标定重点：上限必须放宽——重度噪声会把窗口峰谷差抬高（noise.01 下
                                     //   真实跳跃 rise/scale 可被顶到 0.15+），旧上限 0.125 会误杀 ~28 次真跳。
                                     //   fp01(0.230)/fp02(0.554) 这类「超大 rise」误报现由 D4/D5 会话门兜底，
                                     //   故上限只需挡住「换人/镜头跳变」级别的极端值（≥0.30）。
const RISE_PCT = 0.08;               // D1：窗口峰谷取稳健分位（0.08 → 8/92 分位），抑制单帧噪声尖峰
const RISE_ARMED_MIN_K = 0.012;      // D1b：冷启动前几跳放宽下限（首跳 rise/scale 偏小的现实）
const RISE_ARMED_MAX_K = 0.150;      // D1b：冷启动前几跳放宽上限
const RISE_ARM_K = 3;                // D1b：前 N 次计数使用放宽门（覆盖冷启动前 3 跳的特例）
// —— D3：检测连续性（span）门 ——
// 诊断（tools/proto_span.js）：真实跳绳每次 fire 时「最近 16 个有效帧的原始帧跨度」恒为 15（100% 连续、
//   窗口内最大 null 间隙=1）；而误报 fire 的窗口跨度显著偏大（fp01=55、fp02=126/130，间隙 27~104）。
//   原理：rise 窗口按「有效帧」计数，一旦检测稀疏（大量 null），窗口会跨越几百帧 → 其「峰谷差」其实是
//   长期漂移而非一次起跳 → 必须拒绝。用「窗口原始帧跨度」直接量化连续性：跨度 > RISE_SPAN_MAX×窗口长
//   即判为不连续 → 拒绝该 fire。
// —— D4：首发确认门（fire 节奏门，不死锁）——
// 诊断：真实跳绳 fire-to-fire 间隔恒为 300~433ms；误报是孤立 fire（间隔 2600~19000ms）。
//   但 fp02 首个 fire（f22，rise 与真实首跳重叠，无法用 rise 区分）需要靠「是否成串」判定。
//   做法：首个 fire 不立即入账，先记 _firstFireTs；仅当 FIRE_CONFIRM_MS 内出现第二个 fire 时才确认，
//   并把首火一并回补。稳态下每跳仍即时计数（第 2 跳起 0 延迟），仅整个会话的首跳延迟一拍。
const RISE_SPAN_MAX = 2.5;           // D3：窗口原始帧跨度 > 2.5×RISE_WIN → 检测不连续 → 拒绝
const FIRE_CONFIRM_MS = 2200;        // D4/D5：fire-to-fire「确认建立会话」的最大间隔。标定（tools 扫描）：
                                     //   ≤2200ms：真实 101、fp01=0、fp02=0、合成=0（全绿）；
                                     //   ≥2600ms：fp02 首个孤立 fire 会被误确认（fp02=1）。
                                     //   真实跳绳偶有 1400~1500ms 的短暂丢帧间隙，取 2200 留足余量。
const SESSION_IDLE_MS = 6000;        // D5：会话保持——超过此静默才复位会话、重走确认流程
                                     //   （真实跳绳中途停顿通常 <3s；6s 足以区分「短暂停顿」与「已结束」）
const GAP_MAX_MS = 1200;             // D2：两次计数最大间隔（ms），超过判为孤立/中断

class SkippingCounter {
  constructor(options = {}) {
    this.aBase = options.aBase ?? 0.01;
    this.aAmp = options.aAmp ?? 0.03;
    this.k = options.k ?? 0.5;
    this.minBand = options.minBand ?? 0.006;
    this.maxBand = options.maxBand ?? 0.2;
    this.warmFrames = options.warmFrames ?? 15;
    this.minPeriodMs = options.minPeriodMs ?? 250;
    this.interpMax = options.interpMax ?? 2;
    this.sens = options.sens ?? 5;
    this.minVotes = options.minVotes ?? 1;
    this.syncWindowMs = options.syncWindowMs ?? 300;
    // —— 新增可调项（默认即线上策略；可关/可调以便回归对照）——
    // P0 默认关闭：实测其对「正常条件」的过计修正（+3→+1）不足以抵消
    //   ① 起跳前 4~5 跳的启动延迟（首计数不再即时显示）；
    //   ② 重度退化场景（低帧率/远距离/多噪声）下的欠计。
    //   如需更严的「非节律不入账」，把 rhyEnabled 置 true 即可（下方参数已调优）。
    this.rhyEnabled = options.rhyEnabled ?? false;           // P0 节律验证门开关（默认关）
    this.rhyConfirm = options.rhyConfirm ?? RHYTHM_CONFIRM;  // 严格确认所需的最少点数
    this.rhyTol = options.rhyTol ?? RHYTHM_TOL;              // 间隔一致性容差
    this.rhyMajority = options.rhyMajority ?? RHYTHM_MAJORITY; // 一致间隔占比阈值
    this.rhyGrace = options.rhyGrace ?? RHYTHM_GRACE;        // 释放阀阈值（防空转归零）
    this.rhyGapFactor = options.rhyGapFactor ?? RHYTHM_GAP_FACTOR; // 节奏中断：间隔 > 此倍中位（且有下限）判为中断
    this.rhyMinMs = options.rhyMinMs ?? RHYTHM_MIN_MS;       // 间隔下界
    this.rhyMaxMs = options.rhyMaxMs ?? RHYTHM_MAX_MS;       // 间隔上界
    this.winEnabled = options.winEnabled ?? true;            // P1b 窗口极值基线开关
    this.winLen = options.winLen ?? WIN_LEN;
    this.winUpRatio = options.winUpRatio ?? WIN_UP_RATIO;
    this.winDownRatio = options.winDownRatio ?? WIN_DOWN_RATIO;
    this.winActivateRatio = options.winActivateRatio ?? WIN_ACTIVATE_RATIO;
    this.winPct = options.winPct ?? WIN_PCT;                 // 稳健极值分位（0=原始 min/max）
    this.scaleEnabled = options.scaleEnabled ?? true;        // P1a 人体尺度归一化开关
    this.switchGuard = options.switchGuard ?? true;          // P2a 抗换人开关
    this.maxYJumpRatio = options.maxYJumpRatio ?? MAX_Y_JUMP_RATIO;
    this.detGapMs = options.detGapMs ?? DET_GAP_RESET_MS;
    this.detGapK = options.detGapK ?? DET_GAP_K;
    this.xStableGate = options.xStableGate ?? true;          // P2b X 稳定性门开关
    this.xDriftRatio = options.xDriftRatio ?? X_DRIFT_RATIO;
    // —— 方案A/B：冷启动与晃动防误计（2026-09-13，默认开）——
    this.startGuard = options.startGuard ?? true;            // A 组总开关（冷启动/入场防误计）
    this.armActivateRatio = options.armActivateRatio ?? ARM_ACTIVATE_RATIO;  // A2 真振幅门
    this.armConfirmFrames = options.armConfirmFrames ?? ARM_CONFIRM_FRAMES;  // A3 武装确认帧数
    this.armSilenceFrames = options.armSilenceFrames ?? ARM_SILENCE_FRAMES;  // A3 武装后静默帧数
    this.shakeGuard = options.shakeGuard ?? true;            // B 组总开关（晃动防误计）
    this.yDriftRatio = options.yDriftRatio ?? Y_DRIFT_RATIO; // B2 Y 基线漂移阈值
    this.recoverSilenceFrames = options.recoverSilenceFrames ?? RECOVER_SILENCE_FRAMES; // B3 恢复静默帧
    // —— 方案D：起跳上升幅度门 + 间隔门（2026-09-13，默认开）——
    this.cycleGate = options.cycleGate ?? true;              // D 组总开关
    this.riseWin = options.riseWin ?? RISE_WIN;              // D1 滑动窗口长度（帧）
    this.riseMinK = options.riseMinK ?? RISE_MIN_K;          // D1 上升幅度下限（×scale）
    this.riseMaxK = options.riseMaxK ?? RISE_MAX_K;          // D1 上升幅度上限（×scale）
    this.risePct = options.risePct ?? RISE_PCT;              // D1 窗口峰谷分位
    this.gapMaxMs = options.gapMaxMs ?? GAP_MAX_MS;          // D2 最大计数间隔（ms）
    this.gapGateEnabled = options.gapGateEnabled ?? false;   // D2 间隔门开关（默认关：会死锁，见注释）
    this.fireConfirmMs = options.fireConfirmMs ?? FIRE_CONFIRM_MS; // D4/D5 fire-to-fire 最大间隔
    this.riseSpanMax = options.riseSpanMax ?? RISE_SPAN_MAX; // D3 span 门倍数
    // 注意：_debugMode 只在构造时初始化，reset() 不再清它。
    // 原先 reset() 会把它置 false，导致「重置」按钮或人体离开画面后调试面板数据永久停更。
    this._debugMode = false;
    this._applySens();
    this._applySyncWindow();
    this.reset();
  }

  _applySens() {
    const t = Math.max(0, Math.min(1, (this.sens - 1) / 4));
    this._sensT = t;
    this.kEff = this.k * (1 - 0.5 * t);
    this.minBandEff = this.minBand * (1 - 0.5 * t);
  }

  // sens 越高 → 同步窗口越窄（协同要求越严）：sens1≈350ms，sens3≈225ms，sens5≈100ms
  // 注意：窗口须 < 半周期（绳跳约 300ms），否则任意错帧都落在某次真跳窗口内，门禁失效。
  _applySyncWindow() {
    const t = Math.max(0, Math.min(1, (this.sens - 1) / 4));
    this.syncWindowMs = Math.round(350 - 250 * t);
  }

  setSensitivity(level) { this.sens = level; this._applySens(); this._applySyncWindow(); }
  setMinVotes(n) { n = Math.round(Number(n)); if (isFinite(n) && n >= 1 && n <= 4) this.minVotes = n; }
  setMinPeriod(ms) { this.minPeriodMs = Math.max(1, Number(ms) || this.minPeriodMs); }
  setDebugMode(on) { this._debugMode = !!on; } // 打开后启用 accel 事件等诊断计算

  // 接收来自像素绳子检测器的旋转事件（index.js 调用）
  feedRope(ts = Date.now()) {
    // 时基一致性护栏：ROPE 事件与 JUMP 候选必须来自同一把时钟。
    // 历史坑：update() 不传 ts 时会退化成「帧序号×33.3ms」的合成时基，而这里是 Date.now()，
    // 结果是 ROPE 永远匹配不上窗口，且 _resolvePending 会把所有待裁决候选判成超时拒绝（计数归零）。
    if (this._lastUpdateTs != null && Math.abs(ts - this._lastUpdateTs) > 60000) {
      if (!this._tsWarned) {
        this._tsWarned = true;
        console.warn('[SkippingCounter] feedRope 与 update 时基不一致，已忽略 ROPE 信号');
      }
      return;
    }
    this._ropeEvents.push(ts);
    this._auxEverActive = true;
    this._pruneEvents(ts);
    this._resolvePending(ts); // 绳子可能晚于 JUMP 候选到达，到齐即裁决
  }

  // 延迟裁决：遍历 pending 候选，窗口内有足够辅助信号协同则计、超时无协同则拒
  _resolvePending(now) {
    const timeoutThreshold = this.syncWindowMs * PENDING_TIMEOUT_FACTOR;
    const keep = [];
    for (const p of this._pending) {
      if (now - p.t > timeoutThreshold) {
        this._rejected++;
        if (this._debugMode) { this.debug.votes = 0; this.debug.rejected = this._rejected; }
        continue;
      }
      const g = this._evalGate(p.t);
      if (this._debugMode) {
        this.debug.gateAgree = g.agree; this.debug.gateNeed = g.need;
        this.debug.gateArm = g.arm; this.debug.gateFoot = g.foot;
        this.debug.gateAccel = g.accel; this.debug.gateRope = g.rope;
      }
      if (g.ok) this._commit(p.t);
      else keep.push(p);
    }
    this._pending = keep;
  }

  // 门禁通过 → 进入节律验证门（P0）。确认节律后由 _accept 真正计数。
  // v2：先尝试「严格确认」（中位+多数一致），失败则等释放阀（累积够多候选 → 直接接受）。
  //     两者都会把缓冲里的候选一次性回补，因此最坏只是「延迟几拍」，绝不永久归零。
  _commit(t) {
    if (!this.rhyEnabled) { this._accept(t); return; }
    const times = this._rhyTimes;
    const last = times.length ? times[times.length - 1] : null;
    // 节奏中断（停止/走开）：间隔过大 → 丢弃旧序列重新确认
    if (last != null) {
      // 注意：缓冲尚未成型时不能用「全体中位×倍数」——若缓冲首尾之间本就夹着一个大间隔，
      // 中位会被自身抬高 → 阈值虚高 → 永远不触发（自噬）。故未成型时直接以频率上界判定。
      const breakMs = times.length >= this.rhyConfirm
        ? Math.max(this.rhyMaxMs * 1.1, (this._medianInterval(times) || this.rhyMaxMs) * this.rhyGapFactor)
        : this.rhyMaxMs;
      if (t - last > breakMs) {
        times.length = 0;
        this._rhyConfirmed = false;
      }
    }
    times.push(t);
    if (times.length > RHYTHM_BUF) times.shift();
    if (this._rhyConfirmed) { this._accept(t); return; }

    // 严格确认：点数够 + 中位间隔在合理区间 + 多数间隔一致
    if (times.length >= this.rhyConfirm && this._checkRhythm()) {
      this._rhyConfirmed = true;
      const pend = times.slice();
      for (let i = 0; i < pend.length; i++) this._accept(pend[i]);
      return;
    }
    // 释放阀：节奏不完美但已连续累积足够多候选 → 视为在连续跳，接受并回补（防低速/丢帧下归零）
    if (times.length >= this.rhyGrace) {
      this._rhyConfirmed = true;
      const pend = times.slice();
      for (let i = 0; i < pend.length; i++) this._accept(pend[i]);
    }
    // 未达释放阀：仅暂存，不计数（过滤开头的零星抖动/走动）
  }

  // 缓冲内起跳间隔的中位数（鲁棒于离群；不足 2 点返回 null）
  _medianInterval(times) {
    if (times.length < 2) return null;
    const iv = [];
    for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
    iv.sort((a, b) => a - b);
    return iv[Math.floor(iv.length / 2)];
  }

  // 节律一致性检查（v2：中位 + 多数一致，抗单点离群）
  _checkRhythm() {
    const times = this._rhyTimes;
    if (times.length < 3) return false;
    const iv = [];
    for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
    const sorted = iv.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (!(med >= this.rhyMinMs && med <= this.rhyMaxMs)) return false;
    let good = 0;
    for (let i = 0; i < iv.length; i++) {
      if (Math.abs(iv[i] - med) / med <= this.rhyTol) good++;
    }
    return good >= Math.ceil(this.rhyMajority * iv.length);
  }

  // 真正计数（原 _commit 的计数/周期统计逻辑）
  _accept(t) {
    this.counter++;
    this._riseAcceptCount++;
    if (this._debugMode) this.debug.votes = 1;
    if (this._lastAcceptedTs > 0) {
      const el = t - this._lastAcceptedTs;
      this.intervals.push(el);
      if (this.intervals.length > INTERVAL_BUF_SIZE) this.intervals.shift();
      const sorted = this.intervals.slice().sort((a, b) => a - b);
      this.Tmed = sorted[Math.floor(sorted.length / 2)];
    }
    this._lastAcceptedTs = t;
    this._lastTs = t; // 候选节拍推进（冷却/防卡死）
  }

  // 估计实时人体尺度（≈ bodyH），用于阈值相对化（P1a）
  _estimateScale(features) {
    if (!this.scaleEnabled) return REF_SCALE;
    const ankle = features.ankle, shoulder = features.shoulder, hip = features.hip;
    let s = null;
    if (ankle != null && shoulder != null && isFinite(ankle) && isFinite(shoulder)) {
      s = Math.abs(ankle - shoulder);
    } else if (hip != null && shoulder != null && isFinite(hip) && isFinite(shoulder)) {
      s = Math.abs(hip - shoulder) * SCALE_SH_HIP_K;
    }
    if (s == null || !isFinite(s) || s < 1e-3) s = null;
    if (s == null) return this._scale != null ? this._scale : SCALE_FALLBACK;
    if (this._scale == null) this._scale = s;
    else this._scale = this._scale * (1 - SCALE_EMA) + s * SCALE_EMA;
    this._scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, this._scale));
    return this._scale;
  }

  reset() {
    this.counter = 0;
    this.status = 'DOWN';
    this.frame = 0;
    this.base = null;          // 自适应基线（中线）
    this.amp = 0.02;           // 当前振荡幅度 EMA
    this.dev2 = 0;             // 偏差平方 EMA（用于 std）
    this.inAir = false;        // 迟滞状态
    this._lastTs = -1e9;       // JUMP 候选节拍（冷却/防卡死用）
    this._lastAcceptedTs = 0;  // 最近一次「通过门禁」的计数时刻（周期统计用）
    this.intervals = [];       // 最近计数间隔
    this.Tmed = null;          // 近期周期中位数
    this._lastY = null;        // 上一次有效髋部 Y（丢帧插值用）
    this._gap = 0;             // 当前连续丢帧数
    this._prevLow = false;     // 上一帧是否低于阈值（边沿去抖）
    this.lastBand = this.minBand;
    // —— P0/P1/P2 新增状态 ——
    this.scale = REF_SCALE;    // 当前人体尺度（P1a）
    this._scale = null;        // 尺度 EMA 内部值
    this._win = [];            // 髋 Y 滑动窗口（P1b）
    this.winDy = 0;            // 窗口振幅（调试用）
    this._xWin = [];           // X 位置滑动窗口（P2b）
    this._xDrift = null;       // X 窗口峰峰
    this._rhyTimes = [];       // 节律验证：最近起跳时刻（P0）
    this._rhyConfirmed = false;// 节律是否已确认（P0）
    this._lastValidY = null;   // 抗换人：上一有效髋 Y（P2a）
    this._lastValidX = null;   // 抗换人：上一有效髋 X（P2a）
    this._ignoreStreak = 0;    // 连续忽略帧数（P2a）
    this._prevFrameTs = null;  // 上一帧时间戳（P2a 检测中断判定）
    this._frameDeltas = [];    // 近期帧间隔样本（自适应中断判定）
    this._gapMed = null;       // 帧间隔中位数
    // —— 方案A/B 新增状态（2026-09-13）——
    this._armed = !this.startGuard;  // A：是否已「武装」（武装后才允许计数）；startGuard 关时直接视为已武装
    this._armHits = 0;               // A3：武装确认计数器（连续真实起跳候选数）
    this._armBuf = [];               // A3：未武装时暂存的候选时刻（武装后回补，避免吞真跳）
    this._armSilence = 0;            // A3：武装后剩余静默帧数
    this._wasMoving = false;         // B1/B3：上一帧是否处于 moving（用于检测「恢复静止」沿）
    this._recoverSilence = 0;        // B3：晃动恢复后剩余静默帧数
    // —— 方案D：起跳上升幅度门 + 间隔门状态（2026-09-13）——
    this._riseWin = [];              // 髋 Y 滑动窗口（rise 峰谷计算用）
    this._riseAcceptCount = 0;       // 已接受计数（用于冷启动放宽门）
    this._firstFireTs = null;        // D4：会话首个 fire 时刻（保留兼容，不再直接使用）
    this._firstFireConfirmed = false;// D4：首火是否已被确认
    this._lastFireTs = null;         // D5：上一个 fire 时刻（静默复位/成对判定）
    this._sessionActive = false;     // D5：会话是否已建立（建立后所有 fire 即时入账）
    this._preBuf = [];               // D4：未建立会话期间暂存的 fire 时刻（建立时回补）
    this.lastRise = null;            // 调试：最近一次判定的上升幅度
    this.lastSpan = null;            // 调试：最近一次 rise 窗口的原始帧跨度
    this._cycleRejected = 0;         // 调试：被 rise 门/间隔门拒绝的次数
    // 门禁相关
    this._armEvents = [];
    this._footEvents = [];
    this._accelEvents = [];
    this._ropeEvents = [];
    this._pending = [];        // 待裁决的 JUMP 候选（异步协同用）
    this._auxEverActive = false;
    this._rejected = 0;
    this._accelHist = [];
    this._armSt = this._mkOsc();
    this._footSt = this._mkOsc();
    this._accelSt = this._mkOsc();
    this._kneeSt = this._mkOsc();
    this._legSt = this._mkOsc();
    this._shoulderSt = this._mkOsc();
    this._lastHipFootTs = -1e9;
    this._lastUpdateTs = null;
    this._tsWarned = false;
    this.debug = {
      votes: 0, weight: 0, state: 'DOWN',
      hip: { amp: 0, std: 0 },
      ankle: { amp: 0 }, knee: { amp: 0 },
      wrist: { amp: 0 }, foot: { amp: 0 }, shoulder: { amp: 0 },
      gateAgree: 0, gateNeed: 0, rejected: 0,
      gateArm: 0, gateFoot: 0, gateAccel: 0, gateRope: 0,
    };
  }

  // 出框 / 跟踪中断时的重置：清「跟踪态」但**保留已计数量**。
  //
  // 为什么不直接用 reset()：reset() 会把 counter 清零。训练中途人体短暂离开取景框
  // （或 VisionKit 瞬时丢跟踪）会触发 removeAnchors → 若走 reset() 则已跳数量直接归零，
  // 一组训练作废（用户实测反馈的 bug）。中途丢跟踪只该「暂停计数」，不该「清空成绩」。
  //
  // 与 _fullReset() 等价（内部在检测中断时用的就是它），此处只是对外暴露语义化名字。
  resetTrackingKeepCount() {
    this._fullReset();
  }

  // 全重置：仅清「跟踪态」（基线/窗口/节律/尺度/抗换人），保留计数与周期统计（检测中断时用）
  _fullReset() {
    this.base = null;
    this.amp = 0.02;
    this.dev2 = 0;
    this.inAir = false;
    this._prevLow = false;
    this._win = [];
    this._xWin = [];
    this._xDrift = null;
    this._rhyTimes = [];
    this._rhyConfirmed = false;
    this._lastValidY = null;
    this._lastValidX = null;
    this._ignoreStreak = 0;
    this._scale = null;
    // 方案A/B：检测中断后重新「武装」，并清空晃动/静默计数
    this._armed = !this.startGuard;
    this._armHits = 0;
    this._armBuf = [];
    this._armSilence = 0;
    this._wasMoving = false;
    this._recoverSilence = 0;
    // 丢掉「上一次计数时刻」：中断前后两跳之间的空档不是真实周期，
    // 若保留，下一跳会把「出框空档」当成一个大周期写进 intervals → 抬高 Tmed
    // （Tmed 参与冷却下限 minP 与卡死判定，被污染会让防卡死兜底失效）。
    this._lastAcceptedTs = 0;
  }

  // 方案B1：晃动/走动时的「轻量重置」——只清会被晃动 Y 数据污染的跟踪态，
  // 保留计数、周期统计与武装状态（晃完无需重新热身，静默几帧即可）。
  _resetTracking() {
    this.base = null;
    this.amp = 0.02;
    this.dev2 = 0;
    this.inAir = false;
    this._prevLow = false;
    this._win = [];
    this._rhyTimes = [];
    this._rhyConfirmed = false;
  }

  _mkOsc() { return { base: null, amp: 0.02, active: false, prevLow: false, lastCommitted: -1e9 }; }

  // 单维振荡事件检测：越过基线±band 时触发一次事件（迟滞去抖）
  // sc：人体尺度相对系数（P1a），把绝对 band 阈值相对化
  _stepOsc(st, val, ts, opts, sc = 1) {
    // 关键点丢失时必须把瞬时偏差清零：否则 FOOT 门禁会一直吃上一帧的陈旧 curDev，出现「人不动脚动灯常亮」
    if (val == null || isNaN(val)) { st.prevLow = false; st.curDev = 0; return false; }
    if (st.base == null) { st.base = val; st.curDev = 0; return false; }
    const aB = Math.abs(val - st.base) > BASE_FAST_CONVERGE * st.amp ? BASE_FAST_ALPHA : BASE_SLOW_ALPHA;
    st.base = st.base * (1 - aB) + val * aB;
    const dev = val - st.base;
    st.curDev = dev;
    st.amp = st.amp * OSC_AMP_EMA + Math.abs(dev) * OSC_AMP_ALPHA;
    const band = Math.max(opts.minBand * sc, Math.min(opts.maxBand * sc, opts.k * st.amp));
    const beyond = opts.rising ? (val < st.base - band) : (val > st.base + band);
    let ev = false;
    if (!st.active && beyond) { st.active = true; ev = true; }
    else if (st.active && !beyond) { st.active = false; }
    st.prevLow = beyond;
    if (ev && ts - st.lastCommitted < opts.minGap) ev = false;
    if (ev) st.lastCommitted = ts;
    return ev;
  }

  _pruneEvents(ts) {
    const cutoff = ts - (this.syncWindowMs * PENDING_TIMEOUT_FACTOR + PRUNE_PADDING_MS);
    const f = (arr) => { let i = 0; while (i < arr.length && arr[i] < cutoff) i++; if (i) arr.splice(0, i); };
    f(this._armEvents); f(this._footEvents); f(this._accelEvents); f(this._ropeEvents);
  }

  // 二分查找：返回第一个 >= x 的索引（arr 时间有序）
  _lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  // 评估门禁：统计窗口内同意的「独立」辅助信号数（ARM / FOOT / ROPE；加速度与 JUMP 同源，不计入）
  _evalGate(ts) {
    const W = this.syncWindowMs;
    const lo = ts - W, hi = ts + W;
    let arm = 0, foot = 0, accel = 0, rope = 0;
    if (this._armEvents.length)  arm  = this._lowerBound(this._armEvents,  hi + 1) - this._lowerBound(this._armEvents,  lo);
    if (this._footEvents.length) foot = this._lowerBound(this._footEvents, hi + 1) - this._lowerBound(this._footEvents, lo);
    if (this._accelEvents.length)accel= this._lowerBound(this._accelEvents,hi + 1) - this._lowerBound(this._accelEvents,lo);
    if (this._ropeEvents.length) rope = this._lowerBound(this._ropeEvents, hi + 1) - this._lowerBound(this._ropeEvents, lo);
    const aux = (arm > 0 ? 1 : 0) + (foot > 0 ? 1 : 0) + (rope > 0 ? 1 : 0);
    const need = this._auxEverActive ? this.minVotes : 1; // 优雅降级：无辅助信号则不门禁
    const agree = 1 + aux; // 1 = JUMP 自身
    return { agree, need, ok: agree >= need, arm, foot, accel, rope };
  }

  // —— 方案D：fire 事件处理（D4 会话建立门 + D5 会话保持）——
  // 所有 fire 候选（已过 D1/D3 门）都经此进入计数管线。
  // 语义（"会话建立"模型，兼顾 0 误差与最小启动延迟）：
  //   ① 尚未建立会话时：把 fire 暂存进 _preBuf（保留时刻序列）；仅当「相邻两 fire 间隔 ≤
  //      FIRE_CONFIRM_MS」出现了即视为「确实在连续跳」→ 建立会话。
  //   ② 建立会话时：把 _preBuf 里「距首个成对 fire 不超过 SESSION_IDLE_MS 的」候选全部回补
  //      （补回起跳前的孤立首拍，降低启动延迟），并从此后所有 fire 即时入账。
  //   ③ 会话保持：仅在「超长静默」(> SESSION_IDLE_MS) 后复位、重走建立流程。
  // 效果：真实跳绳（前几拍可能稀疏）→ 建立时回补早段真跳，仅牺牲极短延迟；
  //       孤立噪声（fp01 单 fire；fp02 fire 间隔均 ≥2.6s）→ 永不出现「成对」→ 永不建立 → 0。
  _onFire(ts) {
    if (!this.cycleGate) { this._pending.push({ t: ts }); this._resolvePending(ts); return; }
    const prev = this._lastFireTs;
    this._lastFireTs = ts;
    // 会话超时静默 → 复位，需重新建立
    if (prev != null && (ts - prev) > SESSION_IDLE_MS) {
      this._preBuf = [];
      this._sessionActive = false;
    }
    // 已建立会话：即时入账（0 延迟）
    if (this._sessionActive) {
      this._pending.push({ t: ts });
      this._resolvePending(ts);
      return;
    }
    // 未建立：暂存
    this._preBuf.push(ts);
    if (this._preBuf.length > 64) this._preBuf.shift();
    // 检测「成对」(相邻间隔 ≤ fireConfirmMs) → 建立会话
    if (prev != null && (ts - prev) <= this.fireConfirmMs) {
      this._sessionActive = true;
      // 回补：_preBuf 中距当前不超过 SESSION_IDLE_MS 的全部候选。
      // ⚠️ 回补候选直接走 _commit（已过 D1/D3 门），不能走 _pending——
      //    _pending 的「同步窗口超时」会把时间戳较早的回补候选判为超时拒绝（实测曾导致回补失效）。
      const cutoff = ts - SESSION_IDLE_MS;
      const flush = this._preBuf.filter(t => t >= cutoff);
      this._preBuf = [];
      for (let i = 0; i < flush.length; i++) this._commit(flush[i]);
    }
  }

  // —— 方案D：门禁判定（抽取成公共方法，供「正常 fire」与「武装回补 _armBuf」两条路径共用）——
  // 返回 { pass, rise, span }。
  //   rise = 滑动窗口稳健峰谷差；span = 窗口的原始帧跨度（D3 连续性量化）。
  //   pass = (rise 落在 [loK,hiK]×scale 内) 且 (span ≤ RISE_SPAN_MAX×riseWin)。
  // 注意：回补路径也必须过此门——否则未武装期间累积的候选会「零校验」入账（实测导致 fp01/fp02 误计）。
  _applyDGate(scale) {
    if (!this.cycleGate) return { pass: true, rise: null, span: null };
    const w = this._riseWin;
    let rise = 0, span = 0;
    if (w.length >= 4) {
      const ys = w.map(e => e.y).sort((a, b) => a - b);
      const k = Math.floor(this.risePct * ys.length);
      rise = ys[ys.length - 1 - k] - ys[k];
      span = w[w.length - 1].i - w[0].i;   // 原始帧跨度（含中间 null）
    }
    this.lastRise = rise;
    this.lastSpan = span;
    // D3 span 门：窗口跨度显著超过帧数 → 检测稀疏（大量丢帧）→ 峰谷差实为长期漂移，拒绝。
    if (span > this.riseSpanMax * this.riseWin) return { pass: false, rise: rise, span: span };
    // D1 rise 门：冷启动前 RISE_ARM_K 次计数用放宽门（首几跳 rise 偏小属正常）；此后用标准门。
    const cold = this._riseAcceptCount < RISE_ARM_K;
    const loK = cold ? RISE_ARMED_MIN_K : this.riseMinK;
    const hiK = cold ? RISE_ARMED_MAX_K : this.riseMaxK;
    return { pass: (rise >= loK * scale && rise <= hiK * scale), rise: rise, span: span };
  }

  update(features, ts) {
    if (!features || typeof features !== 'object') {
      if (typeof console !== 'undefined') console.warn('[SkippingCounter] update() received invalid features:', features);
      return { counter: this.counter, status: this.status };
    }
    this.frame += 1;
    if (ts == null) ts = this.frame * DEFAULT_FRAME_MS;

    // P2：检测中断 → 全重置，避免用陈旧状态继续判定。
    // 阈值自适应帧节奏：gap > max(下限, K×近期帧间隔中位)。
    // （固定阈值在低帧率下会被常规丢帧误触发，导致整跳丢失——实测严重退化场景计数直接腰斩）
    if (this._prevFrameTs != null) {
      const gap = ts - this._prevFrameTs;
      const thresh = Math.max(this.detGapMs, (this._gapMed != null ? this._gapMed : 0) * this.detGapK);
      if (gap > thresh) {
        this._fullReset();
      } else if (gap > 0) {
        this._frameDeltas.push(gap);
        if (this._frameDeltas.length > 15) this._frameDeltas.shift();
        const s = this._frameDeltas.slice().sort((a, b) => a - b);
        this._gapMed = s[s.length >> 1];
      }
    }
    this._prevFrameTs = ts;
    this._lastUpdateTs = ts;

    // P1a：实时人体尺度（≈ bodyH），阈值相对化，实现距离无关
    const scale = this._estimateScale(features);
    const sc = scale / REF_SCALE;
    this.scale = scale;

    let hipY = features.hip ?? null;

    // 短丢帧插值：≤ interpMax 帧跟丢时 hold 上一有效值，避免谷底整跳丢失
    if (hipY == null || isNaN(hipY)) {
      if (this._lastY != null && this._gap < this.interpMax) {
        this._gap++;
        hipY = this._lastY;
      } else {
        this._prevLow = false;
        return { counter: this.counter, status: this.status };
      }
    } else {
      this._gap = 0;
      this._lastY = hipY;
    }

    // P2a：抗换人——帧间髋 Y 突变视为换人/毛刺，忽略该帧（不更新任何检测状态，计数保留）
    if (this.switchGuard && this._lastValidY != null &&
        Math.abs(hipY - this._lastValidY) > this.maxYJumpRatio * scale) {
      this._ignoreStreak++;
      if (this._ignoreStreak > MAX_IGNORE_STREAK) this._fullReset(); // 持续异常 → 重新锚定
      return { counter: this.counter, status: this.status };
    }
    this._ignoreStreak = 0;
    this._lastValidY = hipY;

    // P2b / B：水平与垂直稳定性——走动/晃动 → 暂停计数，并重置被污染的跟踪态
    let moving = false;
    if (this.xStableGate) {
      const hipX = features.hipX ?? null;
      if (hipX != null && isFinite(hipX)) {
        this._lastValidX = hipX;
        this._xWin.push(hipX);
        if (this._xWin.length > X_WIN_LEN) this._xWin.shift();
        if (this._xWin.length >= X_WIN_LEN) {
          let xmn = Infinity, xmx = -Infinity;
          for (let i = 0; i < this._xWin.length; i++) { const v = this._xWin[i]; if (v < xmn) xmn = v; if (v > xmx) xmx = v; }
          this._xDrift = xmx - xmn;
        }
      }
      moving = this._xDrift != null && this._xDrift > this.xDriftRatio * scale;
    }
    // B2：晃动常带 Y 分量——髋 Y 相对近期基线的漂移过大也判为 moving。
    // （用「本帧 hipY 与上一帧 base」的偏差衡量；base 尚未建立时跳过）
    if (this.shakeGuard && !moving && this.base != null &&
        Math.abs(hipY - this.base) > this.yDriftRatio * scale) {
      moving = true;
    }

    // 预热：前 warmFrames 帧用大 alpha 快速收敛基线，同时**抑制计数与状态跳变**，
    // 避免基线未收敛时人物站姿微调或入场晃动触发误计。
    const warm = this.frame <= this.warmFrames;
    let aB = warm ? 0.2 : this.aBase;

    if (this.base == null) this.base = hipY;
    this.base = this.base * (1 - aB) + hipY * aB;

    // A1：冷启动锚定冷却起点。原 _lastTs=-1e9 且 warm-up 不推进 → warm-up 结束后第一帧
    // elapsed=ts+1e9 必然通过冷却门 → 「点开始误计 1 个」。此处 warm-up 期间持续推进 _lastTs，
    // 使冷却从真实时间算起（也覆盖 moving 恢复后的第一帧）。
    if (warm) this._lastTs = ts;

    const dev = hipY - this.base;
    const adev = Math.abs(dev);
    this.amp = this.amp * (1 - this.aAmp) + adev * this.aAmp;
    this.dev2 = this.dev2 * (1 - this.aAmp) + dev * dev * this.aAmp;

    // P1a：迟滞带阈值按人体尺度相对化
    const minBandEff = this.minBand * (1 - 0.5 * this._sensT) * sc;
    const maxBandEff = this.maxBand * sc;
    let band = Math.max(minBandEff, Math.min(maxBandEff, this.kEff * this.amp));
    this.lastBand = band;

    // P1b：滑动窗口极值 → 动态上下界（窗口填满且振幅足够时启用；否则退回EMA band）
    this._win.push(hipY);
    if (this._win.length > this.winLen) this._win.shift();
    let lo = this.base - band, hi = this.base + band;
    if (this.winEnabled && this._win.length >= this.winLen) {
      let wmn, wmx;
      if (this.winPct > 0) {
        // 稳健极值：取分位点（如 15/85 分位）替代绝对 min/max，抑制单帧噪声尖峰对上下界的拉扯
        const s = this._win.slice().sort((a, b) => a - b);
        const k = Math.floor(this.winPct * s.length);
        wmn = s[k]; wmx = s[s.length - 1 - k];
      } else {
        wmn = Infinity; wmx = -Infinity;
        for (let i = 0; i < this._win.length; i++) { const v = this._win[i]; if (v < wmn) wmn = v; if (v > wmx) wmx = v; }
      }
      const dy = wmx - wmn;
      this.winDy = dy;
      if (dy >= this.winActivateRatio * scale) {
        lo = wmn + this.winUpRatio * dy;    // 起跳线（约 35% 高位）
        hi = wmx - this.winDownRatio * dy;  // 落地线
        this.lastBand = hi - lo;            // 调试口径：窗口死区宽度
      }
    }

    const elapsed = ts - this._lastTs;
    const hasTmed = this.Tmed != null;
    const minP = hasTmed ? Math.min(this.minPeriodMs, COOLING_PERIOD_RATIO * this.Tmed) : this.minPeriodMs;
    const stuck = hasTmed && elapsed > STUCK_PERIOD_RATIO * this.Tmed;
    const curLow = stuck ? hipY < this.base - STUCK_BAND_RATIO * band : hipY < lo;

    // —— B1/B3：走动/晃动处理 ——
    // B1：处于 moving（X 漂移或 Y 漂移超标）时，判定为不可信 → 重置被污染的跟踪态，本次不计。
    //     注意：只在「非 warm」时重置，避免 warm-up 阶段就被自己清掉基线。
    if (!warm && moving) {
      if (this.shakeGuard || this.xStableGate) this._resetTracking();
      this._wasMoving = true;
      // B3：回到静止后需静默若干帧（在下面的 !moving 分支里设）
      this._prevLow = false;
      return { counter: this.counter, status: this.status };
    }
    // B3：由 moving 恢复到静止的那一刻 → 启动恢复静默（重新建立干净基线后再计数）
    if (this._wasMoving && !moving) {
      this._wasMoving = false;
      this._recoverSilence = this.shakeGuard ? this.recoverSilenceFrames : 0;
    }
    const inRecover = this._recoverSilence > 0;
    if (inRecover) this._recoverSilence--;

    // —— 方案D：维护 rise 计算的滑动窗口（跨越起跳的峰谷差）——
    // 每帧把 髋 Y + 原始帧号 推入环形窗（长度 riseWin≈一个完整周期）。
    // ⚠️ 必须在「武装/未武装」两条路径之前维护——否则未武装期间窗口是空的，回补路径算不出 rise。
    // 存原始帧号是为了算「窗口跨度」——量化检测连续性（D3 span 门）。
    if (this.cycleGate) {
      this._riseWin.push({ y: hipY, i: this.frame });
      if (this._riseWin.length > this.riseWin) this._riseWin.shift();
    }

    // —— A2/A3：武装（armed）门（不吞真跳：确认后回补缓冲候选）——
    // A2：warm-up 结束且出现真振幅（amp ≥ armActivateRatio×scale）才允许累加确认，
    //     纯噪声/站姿微调（amp 很小）不会推进武装。
    // A3：未武装时把「通过门禁的 D 门」的起跳候选按序暂存 _armBuf；缓冲累计到 armConfirmFrames 个即视为
    //     出现「连续真实起跳」→ 置 _armed，并把其中「通过 D 门」的候选一次性回补计数。
    //     ⚠️ 回补必须保留 D 门判定结果（ok），否则未武装期的伪候选会零校验入账。
    const hasRealAmp = this.amp >= this.armActivateRatio * scale;
    let fired = false;
    if (this.startGuard && !this._armed) {
      // 未武装：维护状态机（inAir/status）与候选缓冲，绝不立即计数
      if (!this.inAir && curLow && this._prevLow) {
        if (!warm && !moving && (stuck || elapsed >= minP)) {
          const g = this._applyDGate(scale);      // 回补候选也必须过 D 门
          this._armBuf.push({ t: ts, ok: g.pass });
        }
        if (!warm && !moving) this.inAir = true;
      } else if (this.inAir && hipY > hi) {
        this.inAir = false; this.status = 'DOWN';
      }
      this._prevLow = warm ? false : curLow;
      // 武装判定：缓冲够多（连续出现真实起跳）且有真振幅
      if (!warm && !moving && hasRealAmp && this._armBuf.length >= this.armConfirmFrames) {
        this._armed = true;
        this._armSilence = this.armSilenceFrames;
        const buf = this._armBuf; this._armBuf = [];
        // ⚠️ 回补也必须走 _onFire（含 D4 首发确认门），否则未武装期的孤立伪候选会零校验入账。
        for (let i = 0; i < buf.length; i++) {
          if (buf[i].ok) { this._onFire(buf[i].t); this.status = 'UP'; }
        }
      }
      return { counter: this.counter, status: this.status };
    }
    // A3：武装后的短暂静默（仅用于「武装那一刻」刚发生、基线尚在早期，避免紧跟的余振误计）
    const inArmSilence = this._armSilence > 0;
    if (inArmSilence) this._armSilence--;

    if (!this.inAir && curLow && this._prevLow) {
      if (!warm && !moving && !inRecover && !inArmSilence && (stuck || elapsed >= minP)) {
        // —— 方案D 门禁 ——
        let pass = true;
        if (this.cycleGate) {
          const g = this._applyDGate(scale);
          pass = g.pass;
          // D2 间隔门（默认关）：⚠️ 已证实会「死锁」——首次计数豁免后，_lastAcceptedTs 冻结在首计，
          //   后续真跳一旦间隔 > gapMaxMs 即被拒，被拒 → _lastAcceptedTs 不推进 → 之后所有真跳
          //   距首计都 > gapMaxMs → 永久全拒（真跳 103→1）。故默认关闭，仅作可选项保留。
          if (this.gapGateEnabled && pass && this._lastAcceptedTs > 0 && (ts - this._lastAcceptedTs) > this.gapMaxMs) pass = false;
          if (!pass) this._cycleRejected++;
        }
        if (pass) { fired = true; this.status = 'UP'; }
      }
      if (!warm && !moving) this.inAir = true;
    } else if (this.inAir && hipY > hi) {
      this.inAir = false;
      this.status = 'DOWN';
    }
    this._prevLow = warm ? false : curLow;

    // 提取特征（安全解构）
    const { wrist = null, ankle = null, knee = null, leg = null, shoulder = null } = features;
    if (knee != null) this._stepOsc(this._kneeSt, knee, ts, KNEE_OPTS, sc);
    if (leg != null) this._stepOsc(this._legSt, leg, ts, LEG_OPTS, sc);
    if (shoulder != null) this._stepOsc(this._shoulderSt, shoulder, ts, SHOULDER_OPTS, sc);

    this._accelHist.push(hipY);
    if (this._accelHist.length > 3) this._accelHist.shift();
    let debugAccel = null;
    if (this._accelHist.length === 3) {
      debugAccel = this._accelHist[2] - 2 * this._accelHist[1] + this._accelHist[0];
    }

    if (this._stepOsc(this._armSt, wrist, ts, ARM_OPTS, sc)) { this._armEvents.push(ts); this._auxEverActive = true; }
    const ankleDev = ankle != null && this._footSt.curDev != null ? Math.abs(this._footSt.curDev) : 0;
    const footThr = HIP_FOOT_AMP * sc;
    const hipFootOK = ankleDev > footThr && this.amp > footThr;
    if (hipFootOK && ts - this._lastHipFootTs > FOOT_DEBOUNCE_MS) {
      this._footEvents.push(ts);
      this._auxEverActive = true;
      this._lastHipFootTs = ts;
    }
    if (this._debugMode && debugAccel != null && this._stepOsc(this._accelSt, debugAccel, ts, ACCEL_OPTS, sc)) {
      this._accelEvents.push(ts);
    }

    if (fired) {
      this._onFire(ts);
    }

    // 定期剪枝：原先只有 feedRope() 会调 _pruneEvents，
    // 一旦设备不支持绳索像素采样，_armEvents/_footEvents 就会一直只进不出（长时间训练持续吃内存）。
    if ((this.frame & 63) === 0) {
      this._pruneEvents(ts);
      if (this._pending.length > 16) this._pending.splice(0, this._pending.length - 16);
    }

    // 仅在 debug 模式下填充面板数据（省去每帧 toFixed 开销）
    if (this._debugMode) {
      const d = this.debug;
      d.weight = band;
      d.state = this.status;
      d.hip.amp = this.amp;
      d.hip.std = Math.sqrt(Math.max(0, this.dev2));
      if (!isFinite(d.hip.std)) d.hip.std = 0;
      if (wrist != null) d.wrist.amp = this._armSt.amp;
      if (ankle != null) d.ankle.amp = this._footSt.amp;
      if (knee != null) d.knee.amp = this._kneeSt.amp;
      if (leg != null) d.foot.amp = this._legSt.amp;
      if (shoulder != null) d.shoulder.amp = this._shoulderSt.amp;
    }

    return { counter: this.counter, status: this.status };
  }
}

module.exports = SkippingCounter;
