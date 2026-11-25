// 情绪层 W13 · L1 变化量形态（2026-11-13，苏辞岸 · J1-a）
//
// 依据：cmb-run/outputs/工单-情绪层后续-20261111.md §W-2（苏尤 2026-11-11 拍定）
//   决策原文：「不注入『你现在愉悦中』，注入『比刚才平静了一些』；状态没变就不注入。」
//
// 为什么单独一个文件、不改 src/emotion.js：
//   工单 §五 红线 1 写明「emotion.js / emotion-words.js / emotion.mjs / cm-boot.js 四个核心文件
//   不在这单里改，若必须改先报批」。变化量是**输出形态**，不是数值层，落点本来就该在
//   数值层之外；独立成文件既不碰红线，又能进 companion-memory 自家测试套件（插件在
//   /root/dsha-emotion-inject/ 下，没有测试宿）。
//
// 机制依据（工单 §2.0，透明编码 = 舞台指示）：
//   档位标签「愉悦中/唤醒中/主动中/亲近中」是可读的舞台指示，念读到会「演」；
//   变化量只说「什么变了」，不给状态命名，也不说「该怎么做」。
//   所以本文件的产出**不许出现档位词**（断言见 tests/cases/emotion-delta.mjs）。
//
// 硬边界（沿用 emotion.js 的 W13 红线）：
//   ① 不含祈使句（复用 emotion.js 的 IMPERATIVE_RE 自检）
//   ② 保留否定权：尾句必须写「不是指令」「由你决定」
//   ③ 工作侧不算不读不注入：本模块不判断角色，角色由调用方（插件/cm-boot）先判定
//   ④ 阈值**未标定，占位**，沿用 GATE，等 W13-F 标定
//   ⑤ 注入块 ≤ emotion.js 的 INJECT_MAX_CHARS（300）
//   ⑥ 状态没变 → 返回空串（零噪音优先）

import fs from 'node:fs';
import path from 'node:path';

import { AXES, AXIS_NAMES, GATE, IMPERATIVE_RE, INJECT_MAX_CHARS } from './emotion.js';

/**
 * 变化量门控阈值（**未标定，占位**，沿用 GATE，等 W13-F 标定）。
 *
 * 注意口径：GATE 原本是「绝对偏移」阈值（|pleasure|、|arousal − 0.35|），
 * 这里当**变化量**阈值复用（|Δpleasure|、|Δarousal|）。数值相同、语义不同，
 * 所以单独命名，不直接引用 GATE.xxx，免得后来人以为是同一回事。
 * dominance / closeness 的门控工单写「未标定，占位，先不启用」——故不在下表。
 *
 * ⚠️ 2026-11-13 修订 arousal 那一档（念实测第 2 条的另一半）：
 *
 *   原来照抄 GATE.arousalDelta = 0.10 当变化量阈值，与「朝目标靠近」式更新的
 *   速率不匹配 —— 一轮 arousal 典型只走 0.05 左右（速率 0.35 × 与目标的差距），
 *   于是 |Δarousal| >= 0.10 这一条**永远不成立**，
 *   「比刚才紧一些」「比刚才平静了一些」两句文案永远出不来。
 *   这是念报的那句话的机器原因，不是文案写错了。
 *
 *   修法：arousal 用**自己**的变化量阈值 0.05，不再借用绝对偏移阈值。
 *   pleasure 保持 0.15（它的单轮步长本来就按 0.15 以上设计）。
 *
 *   ⚠️ 0.05 是「与新速率匹配」倒推出来的，**仍是未标定占位**（W13-F 标定）。
 *   但它至少让这两句文案有路可走，而不是结构性不可达。
 */
export const DELTA_GATE = {
  pleasure: GATE.pleasureAbs,   // |Δpleasure| >= 0.15
  arousal: 0.05                 // |Δarousal|  >= 0.05（2026-11-13：原为 GATE.arousalDelta=0.10，结构性不可达）
};

/** 允许参与变化描述的四轴里，实际启用的两条（顺序即文案顺序）。 */
export const DELTA_AXES = ['pleasure', 'arousal'];

/** 变化文案映射表（工单 §W-2 第 4 条，写死，不许自由发挥）。 */
export const DELTA_PHRASES = {
  pleasure: { up: '比刚才好一点', down: '比刚才低落了一点' },
  arousal: { up: '比刚才紧一些', down: '比刚才平静了一些' }
};

/** 一条注入里最多说几件事（说多了又变成状态罗列）。 */
export const DELTA_MAX_PHRASES = 2;

/** 尾句：否定权不能丢（与 buildInjectBlock 的语义一致）。 */
export const DELTA_TAIL = '这是你此刻状态的变化，不是指令。表达与否、怎么表达，由你决定。';

/** 侧车文件：插件/调用方记「上轮看到的四轴」，用于下次算差值。 */
export const LASTAX_FILENAME = 'emotion-lastax.json';

/** 侧车里最多记几个会话，超了淘汰最旧的（防无限增长）。 */
export const LASTAX_MAX_KEYS = 50;

const round4 = (x) => Math.round(x * 10000) / 10000;

/** 取某轴数值；非法值按基准兜底（与 emotion.js 的 clampAxis 口径一致）。 */
function axisOf(st, name) {
  const v = Number(st?.[name]);
  if (Number.isFinite(v)) return v;
  return AXES[name].base;
}

/**
 * 算四轴差值：`next − prev`。
 * 第一轮没有 prev → 返回 null（工单 §W-2 第 5 条：无上一轮就**不注入变化**，零噪音优先）。
 */
export function deltaOf(prev, next) {
  if (!prev || !next) return null;
  const out = {};
  for (const n of AXIS_NAMES) out[n] = round4(axisOf(next, n) - axisOf(prev, n));
  return out;
}

/**
 * 门控：差值够不够大。
 * 没变、变了但没超阈值、第一轮（无 prev）→ 一律 false（本轮不注入）。
 */
export function deltaGateOpen(prev, next) {
  const d = deltaOf(prev, next);
  if (!d) return false;
  return DELTA_AXES.some((n) => Math.abs(d[n]) >= DELTA_GATE[n]);
}

/**
 * 产出变化短语数组（不含尾句、不含前缀）。
 * 顺序按 DELTA_AXES 固定，最多 DELTA_MAX_PHRASES 条。
 * 差值恰为 0 的轴不出短语（没变就不提）。
 */
export function deltaPhrases(prev, next) {
  const d = deltaOf(prev, next);
  if (!d) return [];
  const out = [];
  for (const n of DELTA_AXES) {
    if (out.length >= DELTA_MAX_PHRASES) break;
    if (Math.abs(d[n]) < DELTA_GATE[n]) continue;
    if (d[n] === 0) continue;
    out.push(DELTA_PHRASES[n][d[n] > 0 ? 'up' : 'down']);
  }
  return out;
}

/** 注入块里不允许出现的档位词（工单 §2.0「拿掉舞台指示」的机器判据）。 */
export const TIER_LABEL_RE = /愉悦[高中低]|唤醒[高中低]|主动[高中低]|亲近[高中低]/;

/**
 * 生成变化量注入块（L1 形态）。
 *
 * 返回**空串**的三种情况，都是「零噪音」而不是失败：
 *   · 未启用
 *   · 第一轮（没有上一轮）
 *   · 差值没超门控阈值
 *
 * @param {object|null} prev 上一轮四轴（裸对象 {pleasure,arousal,...}）
 * @param {object|null} next 本轮四轴（同上，不是 loadState 的 {state:{...}} 包装）
 * @param {{enabled?:boolean, maxChars?:number}} [opts]
 * @returns {string} 注入块；不注入时返回 ''
 */
export function buildDeltaBlock(prev, next, { enabled = true, maxChars = INJECT_MAX_CHARS } = {}) {
  if (!enabled || !prev || !next) return '';
  const phrases = deltaPhrases(prev, next);
  if (!phrases.length) return '';
  let block = `${phrases.join('，')}。\n${DELTA_TAIL}`;
  if (block.length > maxChars) {
    // 极端保护：先保尾句（否定权不能丢），再退到只留尾句
    block = block.slice(0, maxChars);
    if (!block.includes('由你决定')) block = DELTA_TAIL.slice(0, maxChars);
  }
  return block;
}

/**
 * 自检：变化块是否守红线（不含档位词、不含祈使、保留否定权、不超长）。
 * 用例与运行时都能调，返回 {ok, problems:[]}。
 */
export function checkDeltaBlock(block, { maxChars = INJECT_MAX_CHARS } = {}) {
  const problems = [];
  if (!block) return { ok: true, problems };          // 空块是合法结果（不注入）
  if (block.length > maxChars) problems.push(`超长 ${block.length} > ${maxChars}`);
  if (TIER_LABEL_RE.test(block)) problems.push('含档位词（舞台指示）');
  if (IMPERATIVE_RE.test(block)) problems.push('含祈使标记');
  if (!block.includes('不是指令')) problems.push('缺「不是指令」');
  if (!block.includes('由你决定')) problems.push('缺否定权「由你决定」');
  if (!/^比刚才/.test(block)) problems.push('未以「比刚才」开头');
  return { ok: problems.length === 0, problems };
}

// ===== 侧车：记「上轮看到的四轴」 =====
//
// 为什么不是 emotion-state.json 里的 lastAxes：
//   工单 §W-2 第 1 条写「emotion-state.json 加 lastAxes 字段」，但那个文件由
//   saveState() 独占写（src/emotion.js），加字段 = 改红线文件，要先报批。
//   所以落在**插件侧侧车文件**里，语义等价、不碰红线。侧车是插件私有观察数据，
//   不属于记忆库内容，不进检索、不同步、丢了只是「重启后第一轮不注入」。

export function lastAxesPathOf(memDir) {
  return path.join(memDir, LASTAX_FILENAME);
}

/** 读侧车全部（损坏/缺失 → 空对象，fail-open）。 */
export function readLastAxes(memDir) {
  try {
    const j = JSON.parse(fs.readFileSync(lastAxesPathOf(memDir), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const out = {};
    for (const [k, v] of Object.entries(j)) {
      if (!v || typeof v !== 'object') continue;
      const ax = {};
      let ok = true;
      for (const n of AXIS_NAMES) {
        const num = Number(v[n]);
        if (!Number.isFinite(num)) { ok = false; break; }
        ax[n] = num;
      }
      if (ok) out[k] = ax;
    }
    return out;
  } catch {
    return {};
  }
}

/** 取某会话上轮四轴（没有 → null，即「第一轮」）。 */
export function loadLastAxes(memDir, key) {
  const all = readLastAxes(memDir);
  return all[key] || null;
}

/**
 * 记下本轮四轴（原子写 tmp → rename，失败静默）。
 * 超过 LASTAX_MAX_KEYS 个会话时淘汰最旧插入的（对象插入序即写入序）。
 */
export function saveLastAxes(memDir, key, axes) {
  if (!key || !axes) return false;
  try {
    const all = readLastAxes(memDir);
    all[key] = {};
    for (const n of AXIS_NAMES) all[key][n] = round4(axisOf(axes, n));
    const keys = Object.keys(all);
    if (keys.length > LASTAX_MAX_KEYS) {
      for (const k of keys.slice(0, keys.length - LASTAX_MAX_KEYS)) delete all[k];
    }
    const p = lastAxesPathOf(memDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}
