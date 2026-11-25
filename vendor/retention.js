// 保留率（retention）——**全库唯一**的时间衰减口径。W15，2026-11-13。
//
// 为什么要有这个文件：
//   改之前库里有**两套**衰减，口径还不一样：
//     · 印象层 `weightOf`：阶梯式，每 3 天扣 0.1，`floor()` 取整
//       （`DECAY_PER_DAY=0.1` / `DECAY_INTERVAL_DAYS=3`，src/impressions.js）
//     · 检索层 `freshnessScore`：指数式 `0.5^(days/halfLife)`，30/180/7 天
//       （src/rank.js）
//   同一条记忆在两个模块里有两种「还剩多少」。用户不会看出来，
//   但排序会：一条 6 天前的事，印象层认为它掉了 0.2，检索层认为它还剩 36%。
//
// 本文件依据《双脑记忆系统》6.1 的保留率公式，取其中**能标定**的部分：
//
//   R(t) = exp(-Δt / S)
//   S    = S0 · (1 + β·n_eff) · (1 + γ·schema_fit) · (1 + δ·arousal)
//
//   S0 = 事实 30 天 / 情景 7 天 / 承诺 ∞
//   β  = 0.3，n_eff 上限 5 次
//   γ ∈ [0, 0.5]（schema_fit，无测量手段 → 默认 0，标未标定）
//   δ ∈ [0, 0.8]（arousal，无测量手段 → 默认 0，标未标定）
//
// 另外两个乘子 `(1+α|valence|)` 与 `(0.5+0.5·utility)`、`(0.5+0.5·relationship_weight)`
// 也**默认关**（=1），理由同上：没有标定数据就不假装有。
// 这不是偷懒，是红线——PDF 6.5 的显著性公式给了六个权重却一个数都没有，
// 我们不能照着编。宁可少一层精度，不可多一个假参数。
//
// 注意量纲：本函数返回**保留比例**（0~1），不是权重分数。
// 调用方拿它去乘自己那套分数。这样印象层与检索层用的是同一个「还剩多少」，
// 而各自的「这条本来多重要」仍然分开——那本来就是两件事。

const DAY_MS = 86400000;

/**
 * 半衰期基数 S0（天）。
 *
 * 与 PDF 的差别只有一处：PDF 用「事实 / 情景 / 承诺」三分，
 * 我们的 tag 有八种，映射如下（见 kindOfTag）。
 * `agreement` 给 `Infinity` 是照 PDF 原文——答应过的事不随时间变淡。
 */
export const S0_DAYS = {
  fact: 30,
  event: 7,
  agreement: Infinity
};

/** β：n_eff 的加成系数，PDF 给 0.3。 */
export const BETA = 0.3;
/** n_eff 上限：PDF 给「上限 5 次」。没有它，被用得多的事会永生化。 */
export const N_EFF_CAP = 5;

/**
 * tag → 保留率类型。
 *
 * 这层映射是我们加的（PDF 只给了三种 kind，没给 tag）。
 * 依据是「这件事本身会不会过期」：
 *   · identity（他是谁）/ relation（关系边界）/ preference（喜好）
 *     → fact：慢变，30 天
 *   · agreement（答应过的事 / 约定 / 承诺）
 *     → agreement：不过期
 *   · event（带日期的共同经历）/ emotion（当时的情绪）/ meme（一时的梗、口头禅）
 *     → event：快变，7 天
 *   · misc（琐事）
 *     → fact：给中间值，不值得为它单开一档
 */
export function kindOfTag(tag) {
  switch (tag) {
    case 'agreement': return 'agreement';
    case 'event': case 'emotion': case 'meme': return 'event';
    case 'identity': case 'relation': case 'preference': case 'misc': return 'fact';
    default: return 'fact';
  }
}

/**
 * 计算保留率。
 *
 * @param {object} opts
 * @param {number} opts.from       计时起点（ms）——「最后一次被真正提起」的时间
 * @param {number} [opts.now]      现在（ms）
 * @param {string} [opts.kind]     'fact' | 'event' | 'agreement'（默认按 tag 推）
 * @param {string} [opts.tag]      给了 tag 就能自己推 kind
 * @param {number} [opts.nEff]     独立证据数（distinct 事件），0 → 无加成
 * @returns {number} 0~1 的保留比例
 */
export function retention({ from, now = Date.now(), kind, tag, nEff = 0 } = {}) {
  const k = kind || kindOfTag(tag);
  const s0 = S0_DAYS[k];
  // 承诺不过期：不是「衰减很慢」，是真的一点都不掉。
  // 用 Infinity 而不是一个大数，是为了让「永不过期」在数值上也成立（exp(-0)=1）。
  if (s0 === Infinity) return 1;

  const start = Number(from);
  if (!Number.isFinite(start)) return 1;         // 没给时间 = 不外推，按满额
  const days = Math.max(0, (now - start) / DAY_MS);

  const n = Math.max(0, Math.min(N_EFF_CAP, Number(nEff) || 0));
  const s = s0 * (1 + BETA * n);
  const r = Math.exp(-days / s);
  // 浮点保护：exp 在极端情况下会给 0 或 NaN，调用方拿去做乘法要能吃得下。
  return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1;
}

/**
 * 给「半衰期」口径的调用方用（检索层原本是 0.5^(days/halfLife)）。
 * 返回天数：R = 0.5^(days/halfLife) 与 R = exp(-days/S) 等价于
 * halfLife = S·ln2。承诺 → Infinity。
 */
export function halfLifeDaysOf({ kind, tag, nEff = 0 } = {}) {
  const k = kind || kindOfTag(tag);
  const s0 = S0_DAYS[k];
  if (s0 === Infinity) return Infinity;
  const n = Math.max(0, Math.min(N_EFF_CAP, Number(nEff) || 0));
  return s0 * (1 + BETA * n) * Math.LN2;
}
