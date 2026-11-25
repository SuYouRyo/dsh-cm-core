// 词面 IDF 加权 —— W7，2026-11-09。
//
// 上游：ssamurias/dsh-fish · lib/recall.js:205-213（MIT，逐字移植公式）
//   export const IDF_FLOOR = 0.6
//   export const IDF_CEIL = 1.0
//   function idfWeight(df, n) {
//     if (!(n > 1)) return 1
//     const raw = Math.log(1 + n / (1 + Math.max(0, df))) / Math.log(1 + n)
//     const v = IDF_FLOOR + (IDF_CEIL - IDF_FLOOR) * raw
//     return Math.min(IDF_CEIL, Math.max(IDF_FLOOR, v))
//   }
//
// 为什么它不撞「门限不许抄」：
//   df（多少条候选出现过该 gram）和 n（候选总数）都从**当前这次查询的这批候选**里现算——
//   它自己的注释就是这么说的（recall.js:349-361「同一份候选既用来算 df 又用来打分，
//   两个口径必须一致，否则 idf 是拿另一批事件算出来的，词的分量就成了猜的」）。
//   这是**语料内自适应**，不是 0.05 / 1200 那种抄来的绝对门限。
//
// 但上下界 0.6 / 1.0 是**它**在自己语料上标的。按协作约定硬纪律 3，我们：
//   · 公式照搬（数学形状与语料无关）；
//   · 上下界做成**可配置**，默认取它的 0.6/1.0 但**明确标注未在本地标定**，
//     等 B3 尺子跑内部纵向 A/B 后自己定（C8 听苏尤口令，现在不跑）。
//
// 顺带一条纪律（dsh-fish recall.js:382-386 的 LITERAL_BONUS / LITERAL_MISS）：
//   字面量（版本号 0.9.3、文件名 snapshot.json）**整串比、不切碎片**；
//   查询带字面量却一个都没对上 → 整体打折。我们现在纯 bigram，版本号会被切碎误撞。

/** 默认上下界：取自 dsh-fish，**尚未用我们自己的语料标定**。 */
export const DEFAULT_IDF = Object.freeze({
  floor: 0.6,
  ceil: 1.0,
  /** 字面量整串命中的加分（整串比，不切碎）。 */
  literalBonus: 1.5,
  /** 查询带字面量却一个没对上时，整体乘这个折扣。 */
  literalMiss: 0.5
});

/**
 * 一个 gram 的分量：越少候选含它越值钱；下限 floor、上限 ceil。
 * 逐字等价 dsh-fish recall.js:208-213。
 *
 * @param {number} df  这批候选里含该 gram 的条数
 * @param {number} n   候选总数
 * @param {{floor:number,ceil:number}} [cfg]
 */
export function idfWeight(df, n, { floor = DEFAULT_IDF.floor, ceil = DEFAULT_IDF.ceil } = {}) {
  if (!(n > 1)) return 1;
  const d = Math.max(0, Number(df) || 0);
  const raw = Math.log(1 + n / (1 + d)) / Math.log(1 + n);
  const v = floor + (ceil - floor) * raw;
  return Math.min(ceil, Math.max(floor, v));
}

/**
 * 从查询里切出「字面量」——整串比、不切碎片的那部分。
 * 判据（保守，避免把普通词当字面量）：
 *   · 含数字（0.9.3 / 2026-11-08 / 第3章）
 *   · 含 . _ - / 等连接符（snapshot.json / package.json / a_b）
 *   · 全大写英文缩写（README / HTTP）
 *
 * @param {string} query
 * @returns {string[]} 小写化后的字面量（最多 5 个）
 */
export function literalsOf(query) {
  const t = String(query || '');
  const out = [];
  const seen = new Set();
  // ⚠️ 分隔符**不能**含 . _ - / —— 它们是字面量的一部分：
  //   含 "." 会把 0.9.3 切成 0/9/3、把 snapshot.json 切成两段（实测踩过）。
  //   只按空白与中文/英文标点切段，连接符留在段内。
  for (const tok of t.split(/[\s，。、；：！？（）【】「」《》,;:!?()\[\]{}]+/)) {
    const s = tok.trim();
    if (s.length < 3) continue;                    // 太短不当字面量（避免「第3」）
    const hasDigit = /\d/.test(s);
    const hasJoiner = /[._\-\/\\]/.test(s);
    const allUpper = /^[A-Z0-9_.\-\/]+$/.test(s) && /[A-Z]/.test(s);
    if (!(hasDigit || hasJoiner || allUpper)) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 给一批候选算 IDF 加权后的 coverage。
 *
 * 与旧算法的关系（必须等价于 n=1 时）：
 *   旧：coverage = 命中 gram 数 / 查询 gram 总数
 *   新：coverage = Σ(idfWeight(g) × 命中) / Σ(idfWeight(g))
 *   → 全部 gram 权重相同时，两式完全相同。所以这是**旧式的推广**，不是替换。
 *
 * @param {object} p
 * @param {Map<string,Set<number>>} p.index  gram → 文档下标集合
 * @param {Iterable<string>} p.qGrams        查询 gram
 * @param {number} p.nCandidates             候选总数（算 df 用）
 * @param {number[]} [p.candidateIds]        候选文档下标（缺省则用 index 里出现过的全集）
 * @param {{floor:number,ceil:number}} [p.cfg]
 * @returns {Map<number, number>} 文档下标 → 加权 coverage ∈ [0,1]
 */
export function coverageWithIdf({ index, qGrams, nCandidates, candidateIds, cfg = DEFAULT_IDF }) {
  const grams = [...qGrams];
  const out = new Map();
  if (!grams.length || !(nCandidates > 0)) return out;

  // df：这一批候选里有多少条含该 gram。
  // 只数候选，不数全库 —— 与打分同源，避免「拿另一批事件算 idf」。
  const getCount = (set) => set ? set.size : 0;
  const dfOf = (g) => getCount(index.get(g));

  // 权重总和（分母）。用「候选内 df」需要候选全集；这里用 index 的集合大小近似，
  // 因为 index 只含可见 scope 的文档，已经就是候选池。
  let totalW = 0;
  const w = new Map();
  for (const g of grams) {
    const df = Math.min(dfOf(g), nCandidates);
    const ww = idfWeight(df, nCandidates, cfg);
    w.set(g, ww);
    totalW += ww;
  }
  if (!(totalW > 0)) return out;

  // 分子：每个候选命中的 gram 权重之和
  const ids = candidateIds || [];
  if (ids.length) {
    for (const id of ids) {
      let hitW = 0;
      for (const g of grams) {
        const set = index.get(g);
        if (set && set.has(id)) hitW += w.get(g);
      }
      if (hitW > 0) out.set(id, hitW / totalW);
    }
    return out;
  }
  // 没给候选清单：从 gram 倒排里收集
  for (const g of grams) {
    const set = index.get(g);
    if (!set) continue;
    const gw = w.get(g);
    for (const id of set) out.set(id, (out.get(id) || 0) + gw);
  }
  for (const [id, s] of out) out.set(id, s / totalW);
  return out;
}

/**
 * 查询里的字面量在候选正文里整串命中了吗？
 * @returns {{hits:number, missed:number, bonus:number, missFactor:number}}
 *   hits>0 → bonus 生效；missed>0 且 hits===0 → missFactor 生效
 */
export function literalScore(query, text, cfg = DEFAULT_IDF) {
  const lits = literalsOf(query);
  if (!lits.length) return { hits: 0, missed: 0, bonus: 0, missFactor: 1 };
  const body = String(text || '').toLowerCase();
  let hits = 0;
  for (const l of lits) if (body.includes(l)) hits++;
  const missed = lits.length - hits;
  return {
    hits,
    missed,
    bonus: hits > 0 ? cfg.literalBonus * hits : 0,
    missFactor: hits === 0 ? cfg.literalMiss : 1
  };
}

/* ------------------------------------------------------------------ *
 * W9（K4 定性版）：粗粒度 gram 不参与加权 —— 2026-11-10
 *
 * 苏尤 K4：「不直接融进来，提取有用的，甚至是找出思路，合并到我们的库里」。
 *
 * 从洛灯鱼文章抽出的两条经验（不建标签面、不建倒排、不做一跳扩散）：
 *   ① **稀有度加权**：越少候选含它越值钱 —— 这已经由 idfWeight() 实现。
 *   ② **粗标签不参与扩散**：作者原话「一个『游戏』能把半个库拉进来」。
 *      我们的对应物不是标签，是**高频 gram**（「今天」「事情」「说过」）。
 *
 * 所以这里只加一个**判据函数**，不改检索主分、不建任何新结构：
 *   isCoarseGram(df, n, opts) → true 表示这个 gram 太粗，应当压到 floor 或直接不参与。
 *
 * 为什么默认不开：W7 的 IDF 已被真实库 194 题标定为「证据不足、维持默认关」，
 * 粗粒度过滤同属排序增强，同样要先有命中率回归证据。默认关、可显式开。
 * ------------------------------------------------------------------ */

/**
 * 判断一个 gram 是否「太粗」（出现得太普遍，参与加权会稀释稀有词）。
 *
 * 判据刻意简单、可解释：它在候选里的**占比**超过阈值就算粗。
 * 不引入语义、不查表、不猜。
 *
 * @param {number} df  含该 gram 的候选条数
 * @param {number} n   候选总数
 * @param {{ratio?: number}} [opts] ratio 默认 0.5（一半以上候选都有 → 太粗）
 * @returns {boolean}
 */
export function isCoarseGram(df, n, { ratio = 0.5 } = {}) {
  if (!(n > 0)) return false;
  const d = Math.max(0, Number(df) || 0);
  return d / n >= ratio;
}

/**
 * 把一个 gram 的权重按「粗不粗」压到 floor。
 * **不改变 idfWeight 的数学**，只是在外面加一层可关的钳制。
 *
 * @param {number} df
 * @param {number} n
 * @param {{ratio?:number, floor?:number, ceil?:number}} [opts]
 * @returns {number} 权重
 */
export function idfWeightWithCoarse(df, n, { ratio = 0.5, floor = DEFAULT_IDF.floor, ceil = DEFAULT_IDF.ceil } = {}) {
  const w = idfWeight(df, n, { floor, ceil });
  return isCoarseGram(df, n, { ratio }) ? floor : w;
}
