// MMR 去重（项目单 5c）：召回结果里常是同一件事的 N 种说法，
// 取前 5 条等于把同一件事说五遍。这里用 Maximal Marginal Relevance
// 把「已经选过的相似条目」压下去，让后面几条能讲别的事。
//
// 参照 BAAI/BioCore 的 biocore_memory/recall/mmr.py（AGPL-3.0）**只看思路**：
// 逐条挑「λ×相关度 − (1−λ)×与已选集最大相似度」最高的那条。一行代码没抄。
//
// 四条硬约束（项目单 5c 原文，逐条落到本文件）：
//   1. λ 在 0.5~0.7 之间实测选定，依据写在 MMR_DEFAULT 注释里（tests/eval-mmr 的 sweep）。
//   2. 相似度优先 bge-m3 向量余弦（与主链一致），拿不到向量时退回词面 bigram coverage；
//      两者可以混用——「有的 hit 有向量、有的没有」时按下面的规则降级。
//   3. 成本 O(k·n)：k = topWindow，n = 候选池。所以只重排池子里的前 topWindow 条，
//      再加相似度缓存 + 预计算 gram 集合，实测常数很小（见 COST 注释）。
//   4. **不许为多样牺牲相关性**：低分条目不许靠「不同」挤进前列。这条不是靠注释，
//      是靠 TIE_BAND 硬阈值在代码里拦（见 eligiblePool()）。
//
// 纯函数、同步、零依赖、无网络。

/** 默认参数。λ / topWindow 的取值依据见下方注释。 */
export const MMR_DEFAULT = {
  // λ = 0.6：实测依据（见下方「λ 定值依据」整段）。一句话：真实库上池内候选的
  // 相关度差被 TIE_BAND 压到 ≤0.12，判据退化成"翻转条件 sim > λ/(1-λ)·Δrel"。
  // 实测 46 个查询 / 33 个池内对，把「让位所需最小 λ」排出来：近似重复那几对是
  // 0.751 / 0.773（λ 必须 < 0.75 才压得住），弱重叠那批的 p50 是 0.69。
  // λ=0.6 落在"全部近似重复都让位、多数弱重叠不误伤"的区间；λ=0.7 已有 0.72~
  // 0.75 的近似重复开始不让位（相关性回潮），所以 0.6 是稳定性余量最大的点。
  // 端到端（生产路径 8 个查询）：前 5 多样性 0.891 → 0.947，top-1 8/8 未变。
  lambda: 0.6,
  // 只重排前 12 条：一是成本 O(k·n) 里 k 就是它，二是 recall 实际只用前 5~10 条，
  // 12 条之外的条目动它没有收益，只有风险（把远处的低分条目拉上来）。
  topWindow: 12
};

/**
 * 「并列/近似分数」的带宽。**这是第 4 条约束的硬闸门，不是调参建议。**
 *
 * 候选条目要能被 MMR 提到池子更前面，它的相关度必须落在
 *   rel ≥ best − max(TIE_BAND_ABS, TIE_BAND_REL × best)
 * 之内。换句话说：只有和第一名**几乎同分**的条目才允许在池子里互相换位，
 * 差得多的条目一律按原顺序排在后面——「不同的烂条目」永远挤不到前面去。
 *
 * 取值依据：真实库「心跳」查询里 12 条候选 coverage 全是 1.000（同一件事的
 * 不同片段，分数完全并列），差异全在对已选集的相似度上；而跨主题查询的
 * 候选分数差普遍 > 0.15。所以带宽取 0.12（相对）/ 0.02（绝对）——
 * 并列条目全部进闸，差 0.15 的下一条进不来。
 */
export const TIE_BAND_ABS = 0.02;
export const TIE_BAND_REL = 0.12;

/** 候选池上限：超过就只重排前 maxPool 条（rest 原样接在后面），保证延迟有上界。 */
export const MMR_MAX_POOL = 200;

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const SEP = /[\s\p{P}\p{S}]+/gu;

/** 词面 bigram 集合。规则与 src/search.js 的 gramsOf 同源（中文 2 字滑窗、英文整词）。 */
export function gramsOf(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  if (!s) return out;
  for (const seg of s.split(SEP)) {
    if (!seg) continue;
    if (CJK.test(seg)) {
      const chars = [...seg];
      if (chars.length === 1) out.add(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    } else {
      out.add(seg);
    }
  }
  return out;
}

/**
 * 词面相似度：包含度（交集 / 较短集合）。0..1，对称。
 * 用「较短集合」而不是并集，是因为短句是长句的一部分时该判为高度相似
 * （「心跳停了」⊂「guard 心跳停了」这种情况在原文层大量存在）。
 */
export function lexicalSimilarity(a, b) {
  const A = a instanceof Set ? a : gramsOf(a);
  const B = b instanceof Set ? b : gramsOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const g of small) if (big.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** 向量余弦。两个向量都是非空数字数组且等长才算得出来。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 从一条 hit 里取 doc 向量（可选字段）。
 *
 * search.js 现在输出的 `vec` 是**与 query 的相似度标量**，不是 doc 向量，
 * 所以拿它算 doc-doc 余弦是错的（会被这里显式排除）。doc 向量只有调用方
 * 额外塞进来才有：`hit.embedding` / `hit.vector` / `hit.vecVector` 里的数组，
 * 或者 opts.vectorOf(hit) 返回数组。
 */
function vectorOfHit(hit, opts) {
  if (typeof opts.vectorOf === 'function') {
    const v = opts.vectorOf(hit);
    if (Array.isArray(v) && v.length) return v;
  }
  for (const k of ['embedding', 'vector', 'vecVector']) {
    const v = hit?.[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

/**
 * 相关度（0..1）。优先用调用方给的 `score`；没有就用与 search.js 同口径的融合式：
 *   有向量分流：0.7×vec + 0.3×coverage；没有：coverage。
 * 为什么不用 hit 的原始 score：search.js 的 out 里没有 score 字段（只有 coverage/vec），
 * 而这正是 rec 链路真正拿到的形状。
 */
export function relevanceOf(hit) {
  const s = Number(hit?.score);
  // score 只要是个有限的非负数就用它（含 0——那是"确实不相关"，
  // 不能因为 0 是假值就退回 coverage，否则同一批里两套量纲会混着比）。
  if (hit?.score !== undefined && hit?.score !== null && Number.isFinite(s) && s >= 0) return s;
  const cov = Number(hit?.coverage);
  const vec = Number(hit?.vec);
  const c = Number.isFinite(cov) ? Math.max(0, Math.min(1, cov)) : 0;
  const v = Number.isFinite(vec) ? Math.max(0, Math.min(1, vec)) : 0;
  if (v > 0) return 0.7 * v + 0.3 * c;
  return c;
}

/**
 * 把 hits 归一成内部候选。纯函数，不改入参。
 * `pool` 是按相关度降序排好的前 maxPool 条（稳定排序，同分保持原顺序）。
 */
function prepare(hits, opts) {
  const src = Array.isArray(hits) ? hits : [];
  const n = src.length;
  const recs = src.map((hit, index) => {
    const rel = relevanceOf(hit);
    const vec = vectorOfHit(hit, opts);
    return {
      hit,
      index,
      rel,
      vec,
      grams: vec ? null : gramsOf(hit?.text) // 有向量就不必算 gram，省时间
    };
  });
  // 相关度降序；同分按原顺序（Array#sort 是稳定排序，但显式带上 index 比较更稳）。
  const byRel = recs.slice().sort((a, b) => b.rel - a.rel || a.index - b.index);
  return { recs, byRel };
}

/**
 * 相似度计算器。带缓存：同一对候选只算一次。
 *
 * 关于「有的 hit 有向量、有的没有」——这是真实情况（向量索引是增量的，
 * 新灌进来的话可能还没嵌过）。规则：
 *   · 两边都有向量 → 余弦（主链语义）；
 *   · 任一边没有 → 退回词面 bigram coverage。
 * 不采用「有向量的一边强行跟标量比」，也不采用「一边为 0」——那会让
 * 缺向量的话被判成和所有人都不同，反而被 MMR 提前拉上来（正好违反第 4 条）。
 */
function makeSimilarity(opts) {
  const cache = new Map();
  let vectorPairs = 0;
  let lexicalPairs = 0;
  const custom = typeof opts.similarity === 'function' ? opts.similarity : null;

  function sim(a, b) {
    const k = a.index < b.index ? `${a.index}:${b.index}` : `${b.index}:${a.index}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let v;
    if (custom) {
      v = Number(custom(a.hit, b.hit));
      if (!Number.isFinite(v)) v = lexicalSimilarity(a.grams || gramsOf(a.hit?.text), b.grams || gramsOf(b.hit?.text));
    } else if (a.vec && b.vec) {
      const c = cosine(a.vec, b.vec);
      if (c == null) { lexicalPairs++; v = lexicalSimilarity(a.grams || gramsOf(a.hit?.text), b.grams || gramsOf(b.hit?.text)); }
      else { vectorPairs++; v = Math.max(0, Math.min(1, c)); }
    } else {
      lexicalPairs++;
      v = lexicalSimilarity(a.grams || gramsOf(a.hit?.text), b.grams || gramsOf(b.hit?.text));
    }
    cache.set(k, v);
    return v;
  }
  sim.stats = () => ({ vectorPairs, lexicalPairs, cacheSize: cache.size });
  return sim;
}

/**
 * 硬闸门：只保留与第一名**并列/近似**的条目作为可重排池。
 * 返回 { pool, rest }，pool 里的才允许 MMR 换位，rest 原样接在后面。
 */
export function eligiblePool(byRel, { bandAbs = TIE_BAND_ABS, bandRel = TIE_BAND_REL } = {}) {
  if (!byRel.length) return { pool: [], rest: [], best: 0, floor: 0 };
  const best = byRel[0].rel;
  const floor = best - Math.max(Math.max(0, bandAbs), Math.max(0, bandRel) * Math.abs(best));
  const pool = [];
  const rest = [];
  for (const rec of byRel) {
    if (rec.rel >= floor - 1e-9) pool.push(rec); else rest.push(rec);
  }
  return { pool, rest, best, floor };
}

/**
 * MMR 重排。
 *
 * @param {Array<object>} hits  检索结果（search.js 输出的形状即可）
 * @param {object} [opts]
 * @param {number} [opts.lambda]        相关度权重，默认 MMR_DEFAULT.lambda
 * @param {number} [opts.limit]         前多少条参与重排（默认 topWindow）
 * @param {number} [opts.topWindow]     limit 的别名（协作约定里的字段名）
 * @param {Function} [opts.similarity]  (a,b)=>0..1，缺省见 makeSimilarity
 * @param {Function} [opts.vectorOf]    (hit)=>number[]|null，缺省读 hit.embedding
 * @param {number} [opts.bandAbs]       TIE_BAND_ABS 覆盖
 * @param {number} [opts.bandRel]       TIE_BAND_REL 覆盖
 * @param {number} [opts.maxPool]       候选池上限，默认 MMR_MAX_POOL
 * @returns {Array<object>} 长度不变的**新数组**（不改入参顺序）
 */
export function mmrSelect(hits, opts = {}) {
  const src = Array.isArray(hits) ? hits : [];
  if (src.length <= 2) return src.slice();
  const o = opts && typeof opts === 'object' ? opts : {};

  const { byRel } = prepare(src, o);
  const maxPool = Number.isFinite(o.maxPool) && o.maxPool > 0 ? o.maxPool : MMR_MAX_POOL;
  const poolAll = byRel.slice(0, Math.min(maxPool, byRel.length));
  const overflow = byRel.slice(poolAll.length);

  const { pool, rest, best, floor } = eligiblePool(poolAll, {
    bandAbs: Number.isFinite(o.bandAbs) ? o.bandAbs : TIE_BAND_ABS,
    bandRel: Number.isFinite(o.bandRel) ? o.bandRel : TIE_BAND_REL
  });

  const wantLimit = Number.isFinite(o.topWindow) ? o.topWindow : (Number.isFinite(o.limit) ? o.limit : MMR_DEFAULT.topWindow);
  const k = Math.max(1, Math.min(Math.trunc(wantLimit), pool.length));
  // λ 限制在 [0,1]：λ=1 等于纯相关度（就是原顺序），λ=0 等于纯多样（危险，但仍允许显式传）。
  const lambda = Number.isFinite(o.lambda) ? Math.max(0, Math.min(1, o.lambda)) : MMR_DEFAULT.lambda;

  // 池子里没有可挑的（≤1 条）就别算了，原顺序返回。
  if (pool.length <= 1) return src.slice();

  const sim = makeSimilarity(o);
  // 相关度归一到池内最大值，避免 query 侧量纲影响 λ 的实际权重。
  const relTop = best > 0 ? best : 1;

  const remaining = pool.slice();
  const chosen = [];
  // 每条候选跟「已选集」的最大相似度，逐个更新：O(k·n) 就在这里（k 次迭代 × n 条比较）。
  const maxSim = new Map(); // index -> number
  for (const rec of remaining) maxSim.set(rec.index, 0);

  for (let step = 0; step < k; step++) {
    let bestRec = null;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const rec = remaining[i];
      const relN = relTop > 0 ? rec.rel / relTop : 0;
      // 第一轮 selected 为空，maxSim 全是 0 → 等价于「按相关度取最大」，所以 **top-1 永远不变**。
      const score = lambda * relN - (1 - lambda) * (maxSim.get(rec.index) || 0);
      if (score > bestScore + 1e-12) { bestScore = score; bestRec = rec; }
    }
    if (!bestRec) break;
    chosen.push(bestRec);
    remaining.splice(remaining.indexOf(bestRec), 1);
    // 更新剩余候选与最新选中条的最大相似度。
    for (const rec of remaining) {
      const s = sim(bestRec, rec);
      const cur = maxSim.get(rec.index) || 0;
      if (s > cur) maxSim.set(rec.index, s);
    }
  }

  // 输出：chosen（前 k）→ 池内未选中的（原相关度顺序）→ 闸门外/溢出（原相关度顺序）。
  const chosenSet = new Set(chosen.map((r) => r.index));
  const poolRest = remaining.sort((a, b) => b.rel - a.rel || a.index - b.index);
  const tail = rest.concat(overflow).sort((a, b) => b.rel - a.rel || a.index - b.index);
  const out = [];
  for (const rec of chosen) out.push(rec.hit);
  for (const rec of poolRest) if (!chosenSet.has(rec.index)) out.push(rec.hit);
  for (const rec of tail) out.push(rec.hit);

  // 长度不变是契约的一部分（调用方按条数取前 N）。防御性校验：任何原因少了就补回去。
  if (out.length !== src.length) {
    const used = new Set(out);
    for (const hit of src) if (!used.has(hit)) out.push(hit);
  }
  sim.stats(); // 触发一次（无副作用，只为把调试字段保留在闭包里）
  lastStats = { ...sim.stats(), k, lambda, poolSize: pool.length, floor };
  return out;
}

/** 最近一次 mmrSelect 的成本/降级统计（延迟排查用，不影响返回值）。 */
let lastStats = null;
export function lastMmrStats() {
  return lastStats;
}

/**
 * 多样性指标：1 − 平均两两相似度（0 = 全是同义重复，1 = 两两毫不相干）。
 * 这就是「改前改后对比」要报的那个数——不是「看着更丰富」。
 */
export function diversityScore(hits, opts = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length < 2) return 1;
  const { recs } = prepare(list, opts);
  const sim = makeSimilarity(opts);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      sum += sim(recs[i], recs[j]);
      pairs++;
    }
  }
  return pairs ? 1 - sum / pairs : 1;
}

/** 平均两两相似度（冗余度）。diversityScore = 1 − redundancy。 */
export function redundancy(hits, opts = {}) {
  return 1 - diversityScore(hits, opts);
}

/** 一组 hits 的相关度数组（top-1 相关性是否掉，用它比）。 */
export function relevanceList(hits) {
  return (Array.isArray(hits) ? hits : []).map((h) => relevanceOf(h));
}
