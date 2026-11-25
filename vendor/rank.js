// 排序、门控、时间语义 —— 逻辑移植自 qq-bridge-memory（MIT，© 7ge233）
// 上游：https://github.com/7ge233/qq-bridge-memory  retrieval.py / textproc.py / config.py
//
// 移植原则：**只搬算法，不搬依赖**。
//   上游用 Python + numpy + ORM，这里改写成纯 JS 小数函数，无任何依赖。
//   上游的向量通道（fastembed/onnx）**没有搬**——本机没有 Python.h、没有编译器。
//   所以这里的 sim 可以是「余弦相似度」（将来接向量）或「词面覆盖率」（现在）。
//
// ⚠️ 唯一不能照抄的数字：SIM_GATE = 0.55。
//   上游的 0.55 是在**余弦相似度**上标定的。词面覆盖率是另一个分布，
//   直接套 0.55 会把绝大多数正确结果一起丢掉。本文件默认 0，必须自己标定。

import { retention, kindOfTag } from './retention.js';

/** 上游 config.py 的默认参数（原样搬过来，改一个都写清楚为什么）。 */
export const DEFAULT_RANK = {
  // final_score = 0.7 * sim + 0.2 * freshness + 0.1 * importance
  wSim: 0.7,
  wFresh: 0.2,
  wImp: 0.1,

  halfLifeDays: 30.0,        // 普通记忆半衰期
  factHalfLifeDays: 180.0,   // 长期事实（fact_key 非空）
  eventHalfLifeDays: 7.0,    // 事件类

  simGate: 0,                // ⚠️ 上游 0.55 是余弦口径，词面通道必须重新标定
  // 融合里词面占多少：sim = (1-alpha)*cos + alpha*coverage。
  // embed-bench 实测 alpha 在 0→0.3 区间 @1/@3/@8 完全相同，是平台不是尖峰。
  alpha: 0.3,
  timeHintMultiplier: 1.2,   // 查询里带「昨天/上周」等时间词 → 整体抬一档
  dateAlignBoost: 1.10,      // 查询带日期时，带日期的记忆抬一档
  dateExactBoost: 1.05,      // 日期正好对上，再抬一点
  suspiciousPenalty: 0.5,    // 疑似指令式话术降权（不删）
};

/** 上游 textproc.py TIME_HINTS，原样照抄。 */
export const TIME_HINTS = [
  '昨天', '今天', '前天', '明天', '后天', '上周', '本周', '这周', '下周', '上个月',
  '这个月', '下个月', '去年', '今年', '明年', '上次', '之前', '刚才', '刚刚', '最近',
  '前几天', '周末', '早上', '中午', '晚上', '半夜', '凌晨'
];

/** 上游 textproc.py _GREETING_WORDS，原样照抄。 */
export const GREETING_WORDS = new Set([
  '在吗', '在么', '在不在', '在', '嗯', '嗯嗯', '哦', '哦哦', '啊', '哈', '哈哈',
  '哈哈哈', '呵呵', '嘿', '喂', '你好', '您好', 'hi', 'hello', '早', '早安', '晚安',
  '1', '？', '?', '。。', '...', '、'
]);

const DAY_MS = 86400000;

/**
 * 鲜活度：**保留率**，不是独立的一套衰减。
 *
 * 2026-11-13 W15 改写。这里原本是 `0.5 ^ (days / halfLife)`，
 * 与印象层 `weightOf` 的阶梯式衰减（每 3 天 −0.1，floor 取整）并存 ——
 * 同一条记忆在两个模块里有两个「还剩多少」，而且谁也说服不了谁。
 * 一条 6 天前的事，印象层认为掉了 0.2，检索层认为还剩 36%。
 * 用户看不出来，但排序会。
 *
 * 现在统一走 `src/retention.js`：`R = exp(-Δt/S)`，S0 按类型
 * （事实 30 天 / 情景 7 天 / 承诺 ∞），并带 n_eff 加成。
 * 量纲仍是 0~1，所以下游 `finalScore` 不受影响。
 *
 * 半衰期参数（`cfg.halfLifeDays` 等）保留但**不再用于计算**，
 * 只作为调用方兼容位；真正的基数是 `retention.S0_DAYS`。
 *
 * @param {object} p
 * @param {number} [p.t]          事件时间
 * @param {number} [p.createdAt]  写入时间
 * @param {boolean} [p.isFact]    true → 长期事实（30 天）
 * @param {boolean} [p.isEvent]   true → 事件类（7 天）
 * @param {string}  [p.tag]       有 tag 时按 tag 推类型（优先于 isFact/isEvent）
 * @param {string}  [p.kind]      直接给 'fact' | 'event' | 'agreement'
 * @param {number}  [p.nEff]      独立证据数
 */
export function freshnessScore({ t, createdAt, isFact, isEvent, tag, kind, nEff = 0 } = {}, now = Date.now(), cfg = DEFAULT_RANK) {
  const ref = Number(t) || Number(createdAt) || 0;
  // 无时间戳：保留原行为（0.5，即「不知道多新，按中间算」）。
  // 不能用 retention 的「无时间=满额」——那会让所有没时间戳的文档排到最前面，
  // 检索层与印象层的入库约束不同，这里必须保守。
  if (!ref) return 0.5;
  const k = kind || (tag ? kindOfTag(tag) : (isEvent ? 'event' : isFact ? 'fact' : undefined));
  return retention({ from: ref, now, kind: k, nEff });
}

/** 上游 final_score()：0.7 * 相似度 + 0.2 * 鲜活度 + 0.1 * 重要度。 */
export function finalScore(sim, fresh, importance, cfg = DEFAULT_RANK) {
  return cfg.wSim * sim + cfg.wFresh * fresh + cfg.wImp * importance;
}

/** 上游 has_time_hint()。 */
export function hasTimeHint(text) {
  const s = String(text || '');
  return TIME_HINTS.some((w) => s.includes(w));
}

/**
 * 上游 gate()：这句话值不值得翻记忆。
 * 返回 { ok, reason, tokens }，reason 与上游同名，便于对照。
 *
 * 上游用的是 IDF 信息密度；这里为了零依赖简化为「去重字符数」，
 * 但保留原名与返回结构，将来要接真 IDF 只改内部。
 */
export function shouldSkipRecall(query, cfg = DEFAULT_RANK) {
  const raw = String(query || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const core = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  if (GREETING_WORDS.has(core.toLowerCase())) return { ok: false, reason: 'greeting' };
  if (core.length < 2) return { ok: false, reason: 'too_few_words' };
  // 「嗯」「好」「行」这类重复字
  if (new Set([...core]).size <= 1) return { ok: false, reason: 'low_information' };
  return { ok: true, reason: 'ok' };
}

/**
 * 短查询补齐：查询词少于 3 个时，把最近 4 条对话拼进检索文本。
 * 对应上游 README「短查询补齐」一节（「大后天呢」这类句子不加就永远召不回）。
 */
export function expandQuery(query, recentTexts = [], minWords = 3, take = 4) {
  const core = String(query || '').replace(/[\s\p{P}\p{S}]/gu, '');
  if ([...core].length >= minWords) return String(query || '');
  const tail = recentTexts.slice(-take).join(' ');
  return `${query} ${tail}`.trim();
}

/**
 * 时间状态（上游 temporal_state）：cancelled 不召回；过期默认不再提。
 * 返回 'none' | 'planned' | 'ongoing' | 'past' | 'cancelled'
 */
export function temporalState({ eventAt, validUntil, status } = {}, now = Date.now()) {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'done') return 'past';
  if (Number(validUntil) && now > Number(validUntil)) return 'past';
  if (Number(eventAt) && now < Number(eventAt)) return 'planned';
  if (Number(eventAt)) return 'ongoing';
  return 'none';
}
