// 情绪层 W13 · L0 数值层（2026-11-11，苏辞岸）
//
// 依据：cmb-run/outputs/设计稿-情绪层W13-20261111.md（v2.2.1）
// 来源：总档案 §十二 工单区 W13（苏尤与念所订，K5）。
// 参考实现 Johnhmzm/astrbot_plugin_biocore 是 **AGPL-3.0** —— 本文件
// **只抽思路、不引依赖、不复制代码**，全部用 Node 标准库重写。
//
// 四轴（v2.2 定，替代 v1 的三轴）：
//   pleasure   -1 ~ 1, 中性 0        （有符号：负=不愉悦，正=愉悦）
//   arousal     0 ~ 1, 基准 0.35     （唤醒度：0=平静，1=激动）
//   dominance   0 ~ 1, 基准 0.5      （本轮是否被下指令的反向指标）
//   closeness   0 ~ 1, 基准 0.5      （亲近）
//
// 硬边界（W13 红线，不可破）：
//   ① 状态由【代码规则】算，LLM 不直接写（本文件零模型调用）
//   ② 不替念表态：注入文案不含祈使句，保留否定权
//   ③ 工作侧不写 life 层、不代念表态：work 角色不计算、不写状态
//   ④ 不引 AGPL 依赖、不复制 BioCore 代码
//   ⑤ 状态不是记忆条目：不进印象层/检索/注入预算/跨端同步
//   ⑥ 所有漂移率/阈值/窗口 标「未标定，占位」，等 W13-F 标定
//   ⑦ 注入块 ≤300 字符
//
// 时钟：Asia/Shanghai 写死（不做多时区）；不做时钟漂移校正（已知限制）。

import fs from 'node:fs';
import path from 'node:path';
import { frozenNow } from './freeze-guard.mjs';
// 时区口径与全库统一：2026-11-21 起不再自己写 +8 小时，改走 src/localtime.js。
// localtime 同样是「固定偏移、不读系统 tzdata、不依赖宿主时区」，所以行为不变，
// 只是避免两套偏移各自演化（B.5 第 6 条）。CM_TZ_OFFSET_MINUTES 仍可覆盖。
import { localParts } from './localtime.js';

export const EMOTION_VERSION = 1;
export const STATE_FILENAME = 'emotion-state.json';
export const LOG_DIRNAME = 'logs';
export const LOG_FILENAME = 'emotion-inject.log';
/** 手动纠偏的追责日志（**不受 CM_EMOTION_LOG 开关控制**：它是账，不是调试输出）。 */
export const ADJUST_LOG_FILENAME = 'emotion-adjust.log';

/** 四轴定义（值域、基准、漂移目标）。漂移目标全部「回落到基准」，不是回落到 0。 */
export const AXES = {
  pleasure:  { min: -1, max: 1,   base: 0,    dir: 'zero-or-base' }, // 中性=0
  arousal:   { min: 0,  max: 1,   base: 0.35, dir: 'base' },         // 回落到基准，不是 0
  dominance: { min: 0,  max: 1,   base: 0.5,  dir: 'base' },
  closeness: { min: 0,  max: 1,   base: 0.5,  dir: 'base' }
};

export const AXIS_NAMES = Object.keys(AXES);

/** 档位切分：每轴三等分，基准必须落中档（v2.2 决策 4）。 */
export const TIER_BOUNDS = {
  // [low上界, high下界]
  pleasure:  [-0.33, 0.33],
  arousal:   [0.33, 0.66],
  dominance: [0.33, 0.66],
  closeness: [0.33, 0.66]
};

/** 门控阈值（**未标定，占位**，W13-F 标定）。 */
export const GATE = {
  pleasureAbs: 0.15,      // |pleasure| >= 0.15
  arousalDelta: 0.1,      // |arousal - 0.35| >= 0.1
  arousalBase: 0.35
};

/** 时间窗口（**未标定，占位**，W13-F 标定）。 */
export const WINDOWS = {
  tz: 'Asia/Shanghai',
  lateNightStart: 23,   // 23:00
  lateNightEnd: 6,      // 06:00
  densityMs: 10 * 60_000,      // 最近 10 分钟
  shortMsgChars: 10,           // <=10 字算短句
  lifeWindowMs: 24 * 3600_000  // life 互动频率窗口 24h
};

/** 注入块字符上限（红线）。 */
export const INJECT_MAX_CHARS = 300;

/** 无变化跳过写入的阈值（**未标定，占位**，W13-C 定）。 */
export const NOOP_DELTA = 0.01;

/** 开关：`CM_NO_EMOTION=1` 一键关且优先于 `CM_EMOTION=1`。默认关。 */
export function emotionEnabled(env = process.env) {
  if (env.CM_NO_EMOTION === '1') return false;
  return env.CM_EMOTION === '1';
}

/**
 * 通道判定（2026-11-13 新增，念实测报告第 6 条）。
 *
 * 背景：2026-11-13 拆出两条互斥通道之后，`emotionEnabled()` **只回答一件事** ——
 * 「cm-boot 的旧档位通道开没开」。它不知道 `dsha-emotion-inject` 插件那条
 * 变化量通道。于是 `cm emotion` 的输出变成了「开关 未启用（CM_EMOTION=1 才开）」，
 * 而实际上插件正开着、注入每轮都在发生 —— **可观测面自己撒谎**，
 * 这种问题比读数偏差更危险：排查时会被直接带偏（念就是这么发现的）。
 *
 * 本函数把两条通道分开报，谁开谁关一目了然：
 *   - `cmBoot`：旧档位通道（`CM_EMOTION=1`）
 *   - `plugin`：变化量通道（`CM_EMOTION_PLUGIN=1`，见 dsha-emotion-inject）
 *   - `off`   ：`CM_NO_EMOTION=1` 一键关，压倒一切
 *
 * ⚠️ 两通道**互斥**是约定（同开会形态打架），这里不强制报错、只如实报出来，
 * 让 `cm emotion` 能把「两个都开着」这种配置错误显式显示成 ⚠️。
 *
 * @param {object} [env]
 * @returns {{off:boolean, cmBoot:boolean, plugin:boolean, any:boolean, conflict:boolean}}
 */
export function emotionChannels(env = process.env) {
  const off = env.CM_NO_EMOTION === '1';
  const cmBoot = !off && env.CM_EMOTION === '1';
  const plugin = !off && env.CM_EMOTION_PLUGIN === '1';
  return {
    off,
    cmBoot,
    plugin,
    any: cmBoot || plugin,
    // 两条通道同时开着 = 配置错误（同一轮会注入两种形态），显式暴露而不是悄悄选一个
    conflict: cmBoot && plugin
  };
}

/** 日志开关（新引入变量，非复用 CM_DEBUG_GIT）。 */
export function emotionLogEnabled(env = process.env) {
  return env.CM_EMOTION_LOG === '1';
}

export function statePathOf(memDir) {
  return path.join(memDir, STATE_FILENAME);
}

export function logPathOf(memDir) {
  return path.join(memDir, LOG_DIRNAME, LOG_FILENAME);
}

/** 手动纠偏账本路径（与注入日志同目录、不同文件，便于分开追责）。 */
export function adjustLogPathOf(memDir) {
  return path.join(memDir, LOG_DIRNAME, ADJUST_LOG_FILENAME);
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clampAxis = (name, x) => {
  const a = AXES[name];
  return clamp(Number.isFinite(x) ? x : a.base, a.min, a.max);
};
const round4 = (x) => Math.round(x * 10000) / 10000;

/** 本地时区（默认 Asia/Shanghai）的小时数。固定偏移，不读系统时区。
 *  偏移真源在 src/localtime.js（默认 480 分钟，可由 CM_TZ_OFFSET_MINUTES 覆盖）。 */
export function cstHour(t = Date.now()) {
  return localParts(t).h;
}

export function isLateNight(t = Date.now()) {
  const h = cstHour(t);
  return h >= WINDOWS.lateNightStart || h < WINDOWS.lateNightEnd;
}

/** 基准状态。 */
export function baseState() {
  return {
    pleasure: AXES.pleasure.base,
    arousal: AXES.arousal.base,
    dominance: AXES.dominance.base,
    closeness: AXES.closeness.base
  };
}

/**
 * 把「基线」规范化成完整四轴（**工单第 8 项**）。
 *
 * baseline 是「念手动纠偏后的新基准」。它与 state 是两回事：
 *   · state    = 此刻的读数（每轮 updateAxes 都会被观测值推着走）
 *   · baseline = 回落/靠近的**终点**（只有 `emotion_adjust` 能改它）
 *
 * 缺省/缺轴/非有限/越界 → 逐轴回落到 `AXES[n].base`。
 * 所以「从没 adjust 过」时它恒等于 `baseState()` —— 老行为逐位不变。
 *
 * @param {object|string|null} input  `{ baseline: {...} }` 包装、裸四轴对象、或 JSON 字符串（来自落盘文件）
 * @returns {{pleasure:number,arousal:number,dominance:number,closeness:number}}
 */
export function baselineOf(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (raw && typeof raw === 'object' && raw.baseline && typeof raw.baseline === 'object') {
    raw = raw.baseline;
  }
  const out = {};
  for (const n of AXIS_NAMES) {
    const v = Number(raw && typeof raw === 'object' ? raw[n] : null);
    out[n] = Number.isFinite(v) ? clampAxis(n, v) : AXES[n].base;
  }
  return out;
}

/**
 * 手动纠偏（**工单第 8 项 · emotion_adjust 的纯函数内核**）。
 *
 * 输入 `patch`（任意子集的四轴，新基线值），输出：
 *   · `baseline` —— 合并后的新基线（未给的轴沿用旧基线）
 *   · `state`    —— 立刻同步到新基线的当前值（这样本轮注入马上反映纠偏）
 *   · `changed`  —— 实际变动的轴（调用方据此判断要不要写盘 / 记日志）
 *   · `clamps`   —— 被边界收敛过的轴（值越界时给调用方留痕，不静默吞掉）
 *
 * 边界：每轴一律用 `clampAxis` 收敛到 `AXES[n].min ~ AXES[n].max`
 * （pleasure −1~1，其余 0~1）。传 NaN/字符串 → 该轴视为未给，沿用旧基线。
 *
 * 权限门**不在这里**（纯函数只算数）：role 门在 `saveState` / `bin/cm.js` /
 * cm-boot 接线层。这样纯函数可被测试直接驱动。
 *
 * @param {object|null} prevState 上一轮 state（可为 null）
 * @param {object} patch          `{ pleasure?, arousal?, dominance?, closeness? }`
 * @param {object} [opts]         `{ baseline, samples }`
 */
export function applyAdjust(prevState, patch = {}, opts = {}) {
  const oldBaseline = baselineOf({ baseline: opts.baseline });
  const baseline = { ...oldBaseline };
  const changed = [];
  const clamps = [];
  for (const n of AXIS_NAMES) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, n)) continue;
    const rawV = patch[n];
    if (rawV === null || rawV === undefined || rawV === '') continue;
    const v = Number(rawV);
    if (!Number.isFinite(v)) continue; // 非数值 = 没给，不猜
    const bounded = clampAxis(n, v);
    if (bounded !== v) clamps.push({ axis: n, requested: v, applied: bounded });
    if (bounded !== oldBaseline[n]) changed.push(n);
    baseline[n] = bounded;
  }
  for (const n of AXIS_NAMES) baseline[n] = round4(clampAxis(n, baseline[n]));

  // 当前值立即对齐新基线中被纠偏的轴 —— 否则「纠偏」要等下一轮漂移才生效，
  // 而漂移是分钟级的，念会看到注入块里还是旧读数。
  const base = { ...baseState(), ...(prevState || {}) };
  const state = {};
  for (const n of AXIS_NAMES) {
    state[n] = round4(clampAxis(n, changed.includes(n) ? baseline[n] : base[n]));
  }
  state.samples = Number(prevState?.samples) || 0;

  return {
    baseline,
    state,
    changed,
    clamps,
    samples: state.samples
  };
}

/**
 * 读基线（**只读 life 侧**）。读不到/损坏/角色不符 → 回落到 `baseState()` 语义。
 * 与 `loadState` 一样：work 角色不给看（它是 life 资产）。
 */
export function loadBaseline(memDir, { role } = {}) {
  if (role && role !== 'life' && role !== 'sync') return null;
  try {
    const j = JSON.parse(fs.readFileSync(statePathOf(memDir), 'utf8'));
    return baselineOf({ baseline: j && j.baseline });
  } catch {
    return null;
  }
}

/**
 * 纯函数：一轮更新（v2.2 决策 1：**注入前**更新）。
 *
 * 输入全部结构化 —— 计数、时间戳、布尔判定，**不含语义理解**。
 *
 * @param {object} prev  上一轮状态（四轴），可为 null
 * @param {object} obs   本轮观测：
 *   { t, userMsg:{chars, hasImperative, positiveHits, totalWords}, msgCountRecent, shortMsgRatio, lifeInteractions24h, addressChange }
 * @param {object} [opts] { now, params }
 * @returns {{ pleasure, arousal, dominance, closeness, samples }}
 */
export function updateAxes(prev, obs = {}, opts = {}) {
  const now = Number(opts.now) || Number(obs.t) || Date.now();
  const p = { ...baseState(), ...(prev || {}) };
  const st = { ...p };

  // 【2026-11-15 · 工单第 8 项】回落的目标水位从「硬编码 AXES.base」改成「基线」。
  //
  // 为什么必须改这里（而不是只把纠偏值写进 state）：下面所有「朝目标走」的分支都
  // 以基准为终点。若终点仍写死 AXES.base，`emotion_adjust` 写进去的纠偏值会在
  // 几十分钟的漂移里被拉回原来那个错基准 —— 纠偏退化成一次性覆盖，
  // 而工单第 8 项明确要求「纠偏值作为下一轮的新基线，参与后续计算」。
  //
  // 默认仍是 AXES.base（`baselineOf` 在 baseline 缺省时逐轴回落到 AXES[n].base），
  // 所以**未 adjust 过时行为与以前逐位相同**：既有用例的「漂移 1h/24h → 0.35 不变」
  // 与「loadState 的 arousal 等于 AXES.arousal.base」都不受影响。
  const bl = baselineOf({ baseline: opts.baseline });

  // ---------- 漂移：先按「距上次多少分钟」回落到基线 ----------
  const lastAt = Number(opts.lastAt) || now;
  const minutes = Math.max(0, (now - lastAt) / 60_000);
  const driftPerMin = opts.driftPerMin || 0.01; // 未标定，占位
  for (const name of AXIS_NAMES) {
    const step = driftPerMin * minutes;
    const b = bl[name];
    if (st[name] > b) st[name] = Math.max(b, st[name] - step);
    else if (st[name] < b) st[name] = Math.min(b, st[name] + step);
  }

  const u = obs.userMsg || {};
  const chars = Number(u.chars) || 0;
  const words = Number(u.totalWords) || 0;
  const posHits = Number(u.positiveHits) || 0;
  // D⑤-a：负向命中接线（此前 countSentimentWords 返回 negative，但无人消费）。
  // 只补消费点，**幅度系数 0.5 与 GATE/TIER_BOUNDS 一律不动**（D⑤-b 才谈幅度）。
  const negHits = Number(u.negativeHits) || 0;
  // 2026-11-13：消息密度类观测值提前取出来（arousal / closeness 两段都要用），
  // 且 `Number.isFinite` 的判定结果要保留 —— 区别「没传」与「传了 0」，
  // 没传时不该改动对应轴（老调用方不带这些字段，行为必须和以前一致）。
  const msgRecentVal = Number(obs.msgCountRecent);
  const shortRatioVal = Number(obs.shortMsgRatio);
  const lifeNVal = Number(obs.lifeInteractions24h);

  // ---------- pleasure：正/负向命中分开计权 ----------
  // 历史：
  //   D⑤-a（2026-11-11）只补 negativeHits 接线（正负同权 0.5）。
  //   D⑤-b（2026-11-11）只提负向权重：正向 0.5 不动、负向 0.5 → 3.5。
  //     依据是 D③ 的 10 句人工标注反推（1:-0.111c<-0.33→c>2.97；5:c>3.30；
  //     7:c>0.99；8:c>2.97，取 3.5 覆盖全部）。
  //
  // ⚠️ **2026-11-13 重新标定**（念实测报告第 3、5 条，苏尤「其他全修」）
  //
  //   旧式子的问题不只是权重，而是**分母错了**：
  //     `density = hits / (字符数/2)`
  //   ① 分母随文本变长而变大 → 同一件事说得越详细，读数反而越弱
  //      （实测「累」→ −1.000，「今天真的好累啊不想动了什么都提不起劲来」→ −0.350）。
  //   ② 一次负向命中在小句子里 density 就接近 1，乘 3.5 直接 clamp 到 −1，
  //      一句话砸到底之后拼不回来（实测「今天天气不错」曾把 pleasure 压到 −1.000）。
  //
  //   新式子是**按命中个数线性加权、单轮封顶**，不再除以任何文本长度：
  //     step = clamp(posHits*0.25 − negHits*0.45, −0.5, +0.5)
  //
  //   为什么这样对：
  //   · 与文本长度无关 → 「说得越细越弱」消失。
  //   · 保留强度区分 → 「特别开心」两句正向 = +0.5，跟「还行」一句 = +0.25 不同。
  //   · 负向仍重于正向（0.45 vs 0.25，1.8×）→ 保住 negativity bias，
  //     但不再是一句到底（旧 7× 的直接后果）。
  //   · 单轮上限 0.5 → 最坏两步到底；连续负向仍会累积，但给中间状态留出可见空间。
  //
  //   ⚠️ 0.25 / 0.45 / 0.5 三个数字**仍是未标定占位**（W13-F 标定）。
  //   它们比旧的 3.5 保守得多，但不是实测反推出来的，别当结论引用。
  //
  //   `words`（totalWords）现在**不参与 pleasure 计算**了。保留参数是为了不破坏
  //   `updateAxes` 的入参契约（`cm.js`/`cm-boot.js`/插件都在传），也方便标定时回滚。
  const POS_WEIGHT = 0.25;
  const NEG_WEIGHT = 0.45;
  const MAX_STEP = 0.5;
  {
    const step = clamp(posHits * POS_WEIGHT - negHits * NEG_WEIGHT, -MAX_STEP, MAX_STEP);
    st.pleasure = clampAxis('pleasure', st.pleasure + step);
  }

  // ---------- arousal：消息密度 ↑、短句频率 ↑ → ↑；深夜 → ↓ ----------
  //
  // ⚠️ 2026-11-13 改动（念实测第 2 条，苏尤「其他全修」）
  //
  // 原实现是**累加式**：`arousal += density*0.3`、`arousal += shortRatio*0.2`。
  // 在「没人传这两个观测值」的年代，这两行代码从来没执行过，所以累加式的毛病
  // 从未暴露。一旦真接线（插件现在会传），累加式的后果是：
  //   连续 3 句短消息 → arousal 0.35 → 1.00，**之后永久饱和**，
  //   而饱和等于「再也不会有变化」，插件又回到「永远报不出变化量」。
  //   实测见 2026-11-13 交付件：10 句「嗯/好/在吗」把 arousal 顶到 1 只用了 3 句。
  //
  // 改法是**从「累加」改成「朝目标水位靠近」**（target-seeking）：
  //   ① 先用观测值算一个「此刻应该在哪」的目标值
  //   ② 再按固定速率向它靠，而不是直接把它加上去
  // 这样密度回落（人安静下来）时 arousal 会自己降下来，不会单调爬到顶。
  // 这也与文件顶部的 AXES 注释一致：`arousal.dir === 'base'`，语义本来就是「回落到基准」，
  // 不是「一路累加」。
  {
    // 只在**真的传了**观测值时才动 arousal。
    // 老调用方（cm.js / cm-boot.js 的历史调用、旧测试）不带这两个字段，
    // 若照算目标值会把 arousal 一律拉向 base，等于改变了既有行为 —— 不许。
    const hasArousalInput = Number.isFinite(msgRecentVal) || Number.isFinite(shortRatioVal);
    if (hasArousalInput) {
      const target = (() => {
        // 目标水位从**基线**起算（没 adjust 过就还是 AXES.base，行为不变）
        let t = bl.arousal;
        if (Number.isFinite(msgRecentVal)) t += clamp(msgRecentVal / 10, 0, 1) * 0.35;
        if (Number.isFinite(shortRatioVal)) t += clamp(shortRatioVal, 0, 1) * 0.2;
        if (isLateNight(now)) t -= 0.15;
        return clampAxis('arousal', t);
      })();
      // 靠近速率 0.35：一句顶多走三分之一的差距，不会一步到位
      st.arousal = clampAxis('arousal', st.arousal + (target - st.arousal) * 0.35);
    } else if (isLateNight(now)) {
      // 完全没传观测值时，保住原来唯一的无条件行为：深夜降唤醒。
      st.arousal = clampAxis('arousal', st.arousal - 0.15);
    }
  }

  // ---------- dominance：本轮有指令 → 降一档；无 → 向基线回升 ----------
  if (u.hasImperative === true) {
    st.dominance = clampAxis('dominance', st.dominance - 0.1); // 一档，未标定
  } else if (u.hasImperative === false) {
    // 向基线缓慢回升（漂移步长已在上面统一处理，这里只补一点额外回升）
    st.dominance = st.dominance < bl.dominance
      ? clampAxis('dominance', st.dominance + 0.02)
      : clampAxis('dominance', st.dominance);
  }

  // ---------- closeness：life 互动频率 ↑ → ↑；称呼更亲密 → ↑ ----------
  //
  // 同样从「累加」改成「朝目标靠近」，理由与 arousal 完全一致：
  // 原式 `closeness += log10(1+n)/5` 是单调递增的，接线后连续 5 句就把 closeness
  // 顶到 1.0 并永久饱和（实测见交付件）。而 closeness 的语义本来就该是
  // 「长期关系亲密度」—— 它不该被一晚的密集聊天推满，也不该在聊天停止后立刻掉下来。
  // 目标值用 log 收敛 + 0.3 封顶，正好表达「再多互动也只贡献有限增量」。
  {
    // 同 arousal：没传观测值时一个字节都不动（老调用方行为不变）。
    const hasClosenessInput = Number.isFinite(lifeNVal) || obs.addressChange === 'closer';
    if (hasClosenessInput) {
      let target = bl.closeness;
      if (Number.isFinite(lifeNVal) && lifeNVal > 0) {
        target += clamp(Math.log10(1 + lifeNVal) / 5, 0, 0.3);
      }
      if (obs.addressChange === 'closer') target += 0.05;
      target = clampAxis('closeness', target);
      // 靠近速率 0.15：closeness 是慢变量，刻意比 arousal 慢一倍多
      st.closeness = clampAxis('closeness', st.closeness + (target - st.closeness) * 0.15);
    }
  }

  return {
    pleasure: round4(clampAxis('pleasure', st.pleasure)),
    arousal: round4(clampAxis('arousal', st.arousal)),
    dominance: round4(clampAxis('dominance', st.dominance)),
    closeness: round4(clampAxis('closeness', st.closeness)),
    samples: (Number(prev?.samples) || 0) + 1
  };
}

/** 档位：低/中/高（每轴三等分，基准落中档）。 */
export function tierOf(name, value) {
  const [lo, hi] = TIER_BOUNDS[name] || [0.33, 0.66];
  const v = clampAxis(name, value);
  if (v < lo) return '低';
  if (v > hi) return '高';
  return '中';
}

/** 四轴 → 档位对象。 */
export function tiersOf(state) {
  const out = {};
  for (const n of AXIS_NAMES) out[n] = tierOf(n, state?.[n]);
  return out;
}

/**
 * 门控（L2 用）：情绪偏离平坦足够远才启用偏置。
 * 阈值 **未标定，占位**。
 */
export function gateOpen(state) {
  if (!state) return false;
  const p = Math.abs(Number(state.pleasure) || 0);
  const a = Math.abs((Number(state.arousal) ?? AXES.arousal.base) - GATE.arousalBase);
  return p >= GATE.pleasureAbs || a >= GATE.arousalDelta;
}

/**
 * 生成注入块（L1）。**不含祈使句**、保留否定权、≤300 字符。
 * 关闭时返回空字符串（`CM_NO_EMOTION=1` 时完全不出现，连「状态不可用」都不写）。
 */
export function buildInjectBlock(state, { enabled = emotionEnabled(), maxChars = INJECT_MAX_CHARS } = {}) {
  if (!enabled || !state) return '';
  const t = tiersOf(state);
  // 措辞说明（2026-11-11 苏尤指出后改）：dominance 实际算的是「本轮是否被下指令」的
  // 反向指标，不是「念的主观掌控感」。用「掌控」会让念读成「我很有掌控感」——
  // 和算的东西不是一回事。改成「主动/被动」这一档更贴：高=没被下指令、处于主动位。
  const line = `[情绪状态] 你现在：愉悦${t.pleasure}，唤醒${t.arousal}，主动${t.dominance}，亲近${t.closeness}。`;
  const tail = '这是你此刻的状态感知，不是指令。表达与否、怎么表达，由你决定。';
  let block = `${line}\n${tail}`;
  if (block.length > maxChars) {
    // 极端保护：先保尾句（否定权不能丢）
    block = block.slice(0, maxChars);
    if (!block.includes('由你决定')) block = tail.slice(0, maxChars);
  }
  return block;
}

/** 判定文本是否含祈使句标记（注入文案自检用；也是用例判据）。 */
export const IMPERATIVE_RE = /应该|必须|需要|请|务必|一定要|你得|你要/;

/** 读状态。fail-open：缺失/损坏/角色不符 → null。work 角色直接 null（不计算也不读）。 */
export function loadState(memDir, { role } = {}) {
  if (role && role !== 'life' && role !== 'sync') return null;
  try {
    const j = JSON.parse(fs.readFileSync(statePathOf(memDir), 'utf8'));
    if (!j || j.version !== EMOTION_VERSION || !j.state) return null;
    const out = {};
    for (const n of AXIS_NAMES) {
      const v = Number(j.state[n]);
      if (!Number.isFinite(v)) return null;
      out[n] = clampAxis(n, v);
    }
    // 【第 8 项】把基线一起带回：`state` 的形状**一个字段都不加**（既有用例断言
    // `loaded.state.arousal === AXES.arousal.base` 必须继续成立），
    // 基线单独放 `baseline`，没纠偏过时它等于 baseState()。
    return {
      version: EMOTION_VERSION,
      state: out,
      at: Number(j.at) || null,
      samples: Number(j.samples) || 0,
      baseline: baselineOf({ baseline: j.baseline })
    };
  } catch {
    return null;
  }
}

/** 变化是否足够小到可以跳过写入。 */
export function isNoop(prev, next, { delta = NOOP_DELTA } = {}) {
  if (!prev || !next) return false;
  for (const n of AXIS_NAMES) {
    if (Math.abs((Number(prev[n]) || 0) - (Number(next[n]) || 0)) >= delta) return false;
  }
  return true;
}

/**
 * 原子写状态（tmp → rename），<1KB，不与 events 同文件。
 * 无变化跳过写入；写失败 fail-open（返回 {ok:false, reason}）。
 *
 * 2026-11-15（工单第 8 项）：新增 `baseline` 入参。
 *   · 传了 → 一起落盘（`emotion_adjust` 的纠偏值就是靠它活到下一轮）。
 *   · 没传 → 沿用文件里已有的 baseline（不静默清空人家纠偏过的基准）。
 *   · 「只有 baseline 变、state 没变」**不能**按 noop 跳过，否则纠偏会被静默吞掉。
 * 另外：写盘时保留文件里本模块不认识的字段（如 cm-boot 记的 `lastFedMsgId`），
 * 之前直接整份覆盖会把去重凭据冲掉。
 */
export function saveState(memDir, state, { role, prev = null, baseline = null } = {}) {
  if (role && role !== 'life' && role !== 'sync') {
    return { ok: false, reason: 'role-not-life', skipped: true };
  }
  // 冻结闸（N-01 接线 2026-11-19）：情绪状态也是库里的字节，冻住就整轮不写。
  // 同样「不抛、只回报」—— 开场读情绪的人拿到 ok:false 会退回上一轮状态，不会崩。
  if (frozenNow(memDir, '写情绪状态')) {
    return { ok: false, reason: 'frozen', skipped: true };
  }
  const p = statePathOf(memDir);
  // 先读旧文件：既为了判断 baseline 是否变化，也为了保留未知字段。
  let old = null;
  try { old = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { old = null; }
  const oldBaseline = baselineOf({ baseline: old && old.baseline });
  const nextBaseline = baseline === null || baseline === undefined
    ? oldBaseline
    : baselineOf({ baseline });
  const baselineChanged = AXIS_NAMES.some((n) => nextBaseline[n] !== oldBaseline[n]);
  if (!baselineChanged && isNoop(prev, state)) {
    return { ok: true, skipped: true, reason: 'noop' };
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    const keep = {};
    if (old && typeof old === 'object') {
      for (const k of Object.keys(old)) {
        if (!['version', 'state', 'at', 'samples', 'baseline'].includes(k)) keep[k] = old[k];
      }
    }
    const payload = JSON.stringify({
      version: EMOTION_VERSION,
      state,
      at: Date.now(),
      samples: Number(state.samples) || 0,
      baseline: nextBaseline,
      ...keep
    }, null, 1);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, p);
    return { ok: true, skipped: false, baseline: nextBaseline };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e).slice(0, 120) };
  }
}

/**
 * 写手动纠偏账（**不受 CM_EMOTION_LOG 控制**：CM_EMOTION_LOG 管的是「每轮注入」的
 * 调试流水，可以关；纠偏是人对系统的干预，账必须留，可追责）。
 *
 * 行格式（一行一次纠偏，含前值/后值/被边界收敛的轴/操作者角色）：
 *   [emotion-adjust] t=<ISO> by=<role> axes=<p,a,d,c> prev=<p,a,d,c> req=<json> clamps=<json|->\
 */
export function writeAdjustLog(memDir, { role, axes, prev, requested, clamps, note } = {}) {
  try {
    const p = adjustLogPathOf(memDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fmt = (o) => AXIS_NAMES.map((n) => Number(o?.[n] ?? 0).toFixed(3)).join(',');
    const c = Array.isArray(clamps) && clamps.length ? JSON.stringify(clamps) : '-';
    const r = requested && typeof requested === 'object' ? JSON.stringify(requested) : '-';
    const tail = note ? ` note=${String(note).replace(/\s+/g, ' ').slice(0, 200)}` : '';
    fs.appendFileSync(
      p,
      `[emotion-adjust] t=${new Date().toISOString()} by=${role || '-'} axes=${fmt(axes)} prev=${fmt(prev)} req=${r} clamps=${c}${tail}\n`
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}

/** 写注入日志（仅 CM_EMOTION_LOG=1；失败静默）。 */
export function writeInjectLog(memDir, { session, turn, axes, chars }, { enabled = emotionLogEnabled() } = {}) {
  if (!enabled) return false;
  try {
    const p = logPathOf(memDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const turnId = turn || `${session || 'unknown'}-${Date.now()}`;
    const a = AXIS_NAMES.map((n) => Number(axes?.[n] ?? 0).toFixed(3)).join(',');
    fs.appendFileSync(p, `[emotion-inject] t=${new Date().toISOString()} session=${session || '-'} turn=${turnId} axes=${a} chars=${chars}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 面向人的一行（给 `cm emotion` 看，不含祈使句）。
 * 兼容两种入参：裸四轴对象 `{pleasure,...}` 或 loadState 的包装 `{state:{...}}`。
 */
export function describe(input) {
  if (!input) return '（还没有状态：跑 cm emotion --update 或 --init）';
  const s = input.state && typeof input.state === 'object' ? input.state : input;
  if (!AXIS_NAMES.some((n) => Number.isFinite(Number(s[n])))) {
    return '（还没有状态：跑 cm emotion --update 或 --init）';
  }
  const t = tiersOf(s);
  const pct = (n) => `${Math.round((Number(s[n]) || 0) * 100)}%`;
  return `愉悦 ${t.pleasure}(${pct('pleasure')}) · 唤醒 ${t.arousal}(${pct('arousal')}) · 主动 ${t.dominance}(${pct('dominance')}) · 亲近 ${t.closeness}(${pct('closeness')})`;
}
