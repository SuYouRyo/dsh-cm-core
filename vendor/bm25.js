// BM25 词面打分 —— B-08 阶段 3，2026-11-20。
//
// 工单：doc-02-done/工单-开源机制借鉴与记忆融合-20261113.md 阶段 3
//   「放弃粗糙的简单字符串匹配，引入词频-逆文档频率权重（借鉴 dsh-meow-memory 的 BM25）」
//   红线：纯 JS 手写、零第三方库；手机端内存 +≤50MB、单次检索 <50ms。
//
// 与 src/idf.js 的分工（**不是替换，是并列的第二个通道**）：
//   idf.js  = W7 的「IDF 加权 coverage」，无 tf、无文档长度归一 → 命中即算 1 分。
//   bm25.js = 真 BM25：带 tf 饱和（k1）与文档长度归一（b），一个 gram 在长文里
//             出现一次不该和短文里出现三次等价。
//   两者的 IDF 形状也不同：idf.js 用 log(1+n/(1+df))/log(1+n) 再线性映射到
//   [floor,ceil]（照抄 dsh-fish）；BM25 用 Robertson/Sparck-Jones 的
//   ln(1 + (N-df+0.5)/(df+0.5))（标准式，恒正）。
//
// ⚠️ 纪律（沿用 idf.js 头注那条）：k1/b 的 1.2/0.75 是文献通用默认值，
//   **没有在我们自己的语料上标定**。所以：
//     · 默认关闭（CM_BM25=1 才开，CM_NO_BM25=1 一键关）；
//     · 参数可由调用方传入，A/B 时逐档扫；
//     · 回执里必须写明「未标定」，不许拿它当已优化的结论。
//
// 内存纪律（为什么这里不另建一套倒排）：
//   实测真库 work 可见层 1009 docs / 31,833 grams / 95,042 postings，
//   现有 index 已是 Map<gram, Set<docIdx>>，heap 约 32MB。若 BM25 平行再建一份
//   tf 表（每个 posting 带一个计数），等于翻倍，直接撞 +50MB 红线。
//   所以本模块**只提供算法**，postings 一律复用 src/search.js 里那一份，
//   tf 只在查询时对**候选文档**现数（见 scanGrams）。
//
// 分词口径（必须与 src/search.js 的 gramsOf 逐字一致）：
//   gramsOf = 「按 /[\s\p{P}\p{S}]+/gu 切段 → 段内含 CJK 就按码点 2 字滑窗取
//   bigram（单字段取单字），否则整段算一个词」。
//   scanGrams 是它的**同口径快速实现**：ASCII 用 charCode 表判分隔符（比
//   \p{P}\p{S} 属性类正则快一个量级），非 ASCII 码位按码位记忆化后用正则兜底，
//   所以冷僻字符也不会判错。等价性不靠推理，靠实测：真库 1009 篇全文逐篇
//   对比「gramsOf 出来的集合 + 词频」与 scanGrams 的结果必须完全一致
//   （见 doc-09-audits 的 B-08 阶段3 证据）。
//
//   ⚠️ 一个必须照抄的细节：gramsOf 判 CJK 用的是**段级** /㐀-鿿.../.test(seg)，
//   只要段里出现一个 CJK 码点，整段就按「逐码点 2 字滑窗」切——连段里的拉丁字母
//   也会跟邻居拼成 bigram。分段函数（SEP）已经把空白/标点切开了，所以这种混合段
//   只可能出现在「中文直接贴着英文」（如「b站」、「约2点」）。scanGrams 复刻了
//   这一条，不是「更聪明地按字符类别切」，否则词表就对不上了。
//
// dl（文档长度）算的是**token 总数**（含重复），不是去重 gram 数：
//   标准 BM25 的 |D| 就是 token 数；用去重数会把「同一句话重复很多遍」的长文
//   判成短文档，长度归一反而失真。实测 1009 篇里有 613 篇两种口径不同。


/** 文献默认值，**未在本地语料标定**（见头注）。 */
export const BM25_DEFAULTS = Object.freeze({
  k1: 1.2,
  b: 0.75
});

/**
 * BM25 的 IDF：ln(1 + (N - df + 0.5) / (df + 0.5))。
 * 恒正（df=N 时也 > 0），不像 log(N/df) 会掉到 0 或负。
 *
 * @param {number} df 含该 gram 的文档数
 * @param {number} n  文档总数
 */
export function bm25Idf(df, n) {
  const N = Number(n) || 0;
  if (N <= 0) return 0;
  const d = Math.min(Math.max(0, Number(df) || 0), N);
  return Math.log(1 + (N - d + 0.5) / (d + 0.5));
}

/**
 * 单 gram 的 tf 饱和项：tf*(k1+1) / (tf + k1*(1-b+b*dl/avgdl))。
 * tf=0 → 0；tf→∞ → (k1+1)。这就是「出现三次不等于三倍」。
 *
 * @param {number} tf
 * @param {number} dl    该文档的 token 数（长度）
 * @param {number} avgdl 平均长度
 * @param {{k1:number,b:number}} [cfg]
 */
export function bm25Tf(tf, dl, avgdl, cfg = BM25_DEFAULTS) {
  const f = Number(tf) || 0;
  if (f <= 0) return 0;
  const k1 = Number.isFinite(cfg.k1) ? cfg.k1 : BM25_DEFAULTS.k1;
  const b = Number.isFinite(cfg.b) ? cfg.b : BM25_DEFAULTS.b;
  const len = Number(dl) > 0 ? Number(dl) : 0;
  const avg = Number(avgdl) > 0 ? Number(avgdl) : 1;
  const norm = k1 * (1 - b + b * (len / avg));
  return (f * (k1 + 1)) / (f + norm);
}


// ---------------------------------------------------------------------------
// 分词：与 src/search.js 的 gramsOf 同口径，但走 charCode 快判。
// ---------------------------------------------------------------------------

/**
 * 快判：0x4E00–0x9FFF 是 CJK 统一表意文字主区，整段都是汉字（Lo 类），
 * 不可能是 \s/\p{P}/\p{S}，所以热路径里可以直接当下标区间判，
 * 省掉 String.fromCodePoint + 正则来确认「它不是分隔符」。
 */
function isHanFast(c) {
  return c >= 0x4e00 && c <= 0x9fff;
}

/** 与 search.js 的 CJK 类同集合：CJK 统一表意 / 日文假名 / 韩文音节。 */
function isCjkCode(c) {
  return (c >= 0x3400 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af);
}

/**
 * ASCII 下的 [\s\p{P}\p{S}] 判定。
 *
 * ⚠️ 必须与正则严格等价，不能「差不多」：JS 的 \s 只含 TAB(09)–CR(0d) 与空格(20)，
 * 不含 00–08 / 0e–1f / 7f 这些 Cc 控制符；它们也不在 \p{P} / \p{S} 里，
 * 所以 gramsOf 会把它们当成普通字符留在词里。首版这里写成 \`c <= 0x20\`
 * 就把它们误判成分隔符了——真库语料里没有这种字符，测试也不会红，
 * 但「等价」就成了假话，所以按位精确对上。
 */
function isAsciiSep(c) {
  if (c >= 0x09 && c <= 0x0d) return true;  // \t \n \v \f \r
  if (c === 0x20) return true;              // 空格
  if (c >= 0x21 && c <= 0x2f) return true;  // ! " # $ % & ' ( ) * + , - . /
  if (c >= 0x3a && c <= 0x40) return true;  // : ; < = > ? @
  if (c >= 0x5b && c <= 0x60) return true;  // [ \\ ] ^ _ `
  if (c >= 0x7b && c <= 0x7e) return true;  // { | } ~
  return false;
}

// 非 ASCII 分隔符（全角标点、不间断空格、各类符号）用正则兜底判定，
// 并按码位缓存：语料里这些字符种类有限，缓存后热路径基本不跑正则。
const SEP_ONE = /^[\s\p{P}\p{S}]$/u;
const sepCache = new Map();
function isSepCode(cp) {
  const hit = sepCache.get(cp);
  if (hit !== undefined) return hit;
  const v = SEP_ONE.test(String.fromCodePoint(cp));
  if (sepCache.size < 4096) sepCache.set(cp, v);
  return v;
}

/**
 * 一次扫描同时给出「文档 token 数」与「查询 gram 的词频」。
 *
 * 为什么不用 gramsOf：gramsOf 会给每条候选现造一个 Set（1009 条候选 = 1009 个
 * Set、十万次插入），而 BM25 只需要查询里那十几个 gram 的频次。
 * 为什么不 split 再用 [...seg]（首版写法）：在真库实测里，split 正则一项就占
 * 整轮 tf 计算的 15.5ms/33.0ms，[...str] 展开再占一大截；改成本函数后
 * 同一批候选从 33.0ms 降到 18.1ms，且逐 gram 结果与 gramsOf 完全一致。
 *
 * 「段」与 gramsOf 对齐：非分隔符连续字符算一段；段内只要出现一个 CJK 码点，
 * 就整段按 2 字滑窗切成 bigram（长度为 1 则取单字），否则整段算一个词。
 *
 * @param {string} text
 * @param {Iterable<string>|null} [wanted] 只统计这些 gram 的词频（已小写化）
 * @returns {{len:number, tf:Map<string,number>}} len = token 总数（含重复）
 */
export function scanGrams(text, wanted = null) {
  // ⚠️ 必须与 gramsOf 一样先小写：查询 gram 是 gramsOf(小写) 出来的，
  // 文档侧不折大小写的话 "Node" 里的 bigram 永远匹配不上 "node"。
  // （把这一行丢掉过一次，全库 18031 篇立刻坏了 12007 篇。）
  const s = String(text || '').toLowerCase();
  const n = s.length;

  // ---- 预建「查询 gram」的查找结构（每个查询只建一次，别放进逐文档热路径）----
  // 2 个 BMP 码点组成的 bigram 压成一个 32 位整数键（a<<16|b），
  // 扫描时不必为每个滑窗现场拼字符串 —— 这是把 top-K 一批候选从 58.5ms
  // 压到 14.8ms 的主要来源（实测真库 100 篇 / 23.2 万字）。
  let tf = null;
  let packed = null;    // Map<int, gram>：双 BMP 码点 bigram
  let astral = null;    // Set<string>：含增补平面码点的 bigram，整数键装不下，退回字符串
  let singles = null;   // Set<string>：单码点 gram（段长 1 的 CJK 段就是它）
  let words = null;     // Set<string>：整词 gram（非 CJK 段原样算一个词；也可与 bigram 同形）
  if (wanted) {
    tf = new Map();
    words = wanted instanceof Set ? wanted : new Set(wanted);
    for (const g of words) {
      const arr = [...g];
      if (arr.length === 2) {
        const a = arr[0].codePointAt(0);
        const b2 = arr[1].codePointAt(0);
        if (a <= 0xffff && b2 <= 0xffff) {
          if (!packed) packed = new Map();
          packed.set((a << 16) | b2, g);
        } else {
          if (!astral) astral = new Set();
          astral.add(g);
        }
      } else if (arr.length === 1) {
        if (!singles) singles = new Set();
        singles.add(g);
      }
    }
  }

  let len = 0;
  let i = 0;
  while (i < n) {
    // --- 跳过分隔符 ---
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      if (isAsciiSep(c)) { i++; continue; }
    } else if (!isHanFast(c) && isSepCode(s.codePointAt(i))) {
      // 代理对：分隔符里没有增补平面字符，但保险起见按码点步进
      i += (c >= 0xd800 && c <= 0xdbff) ? 2 : 1;
      continue;
    }
    // --- 取一段（到下一个分隔符）---
    let j = i;
    let hasCjk = false;
    while (j < n) {
      c = s.charCodeAt(j);
      // ⚠️ 顺序不能反：非 ASCII 必须**先判分隔符、后判 CJK**。
      // CJK 码位区间里混着标点，例如 U+30FB「・」（Po 片假名中点）、
      // U+30A0「゠」（Pd）。gramsOf 是先按 SEP 切开、再看段内有没有 CJK，
      // 所以这些字符只会当分隔符；先判 CJK 就会把它们吃进段里，
      // 于是「MA・NDMF」变成一个段、切出「a・」「・n」「・N」这种垃圾 bigram。
      // 真库 18031 篇里正好有 4 篇因此对不上，就是这么找出来的。
      if (c < 0x80) {
        if (isAsciiSep(c)) break;
      } else if (isHanFast(c)) {
        // 0x4E00–0x9FFF 全是汉字，不可能是分隔符，省掉一次正则兜底
        hasCjk = true;
      } else if (isSepCode(s.codePointAt(j))) {
        break;
      } else if (isCjkCode(c)) {
        hasCjk = true;
      }
      j += (c >= 0xd800 && c <= 0xdbff && j + 1 < n) ? 2 : 1;
    }
    if (hasCjk) {
      // 段内含 CJK → 整段按码点 2 字滑窗（与 gramsOf 的 [...seg] 一致）
      let prev = -1;
      let m = 0;
      for (let k = i; k < j;) {
        const cp = s.codePointAt(k);
        if (prev >= 0) {
          len++;
          if (tf) {
            if (prev > 0xffff || cp > 0xffff) {
              if (astral) {
                const g = String.fromCodePoint(prev) + String.fromCodePoint(cp);
                if (astral.has(g)) tf.set(g, (tf.get(g) || 0) + 1);
              }
            } else {
              const g = packed.get((prev << 16) | cp);
              if (g !== undefined) tf.set(g, (tf.get(g) || 0) + 1);
            }
          }
        }
        prev = cp;
        m++;
        k += cp > 0xffff ? 2 : 1;
      }
      // 段内只有一个码点：gramsOf 取这个单字本身，不算 bigram
      if (m === 1) {
        len++;
        if (tf && singles) {
          const g = String.fromCodePoint(prev);
          if (singles.has(g)) tf.set(g, (tf.get(g) || 0) + 1);
        }
      }
    } else {
      len++;
      if (tf) {
        const seg = s.slice(i, j);
        if (words.has(seg)) tf.set(seg, (tf.get(seg) || 0) + 1);
      }
    }
    i = j;
  }
  return { len, tf: tf || new Map() };
}

/**
 * 只数「查询里出现过的 gram」在文档里的词频。scanGrams 的薄包装，
 * 保留这个入口是因为语义更直白（tfsFor 与用例都用它）。
 *
 * @param {string} text
 * @param {Iterable<string>} qGrams 查询 gram（已小写化）
 * @returns {Map<string, number>} gram → tf
 */
export function countQueryTf(text, qGrams) {
  const w = qGrams instanceof Set ? qGrams : new Set(qGrams || []);
  if (!w.size) return new Map();
  return scanGrams(text, w).tf;
}

/**
 * 文档 token 数（dl）。与 scanGrams(text, null).len 等价，单独留个入口，
 * 让 src/search.js 建索引时读起来是「我在算文档长度」而不是「我在扫词频」。
 * @param {string} text
 * @returns {number}
 */
export function docTokenLen(text) {
  return scanGrams(text, null).len;
}


/**
 * 给一条文档算归一化后的 BM25 相似度 ∈ [0,1]。
 *
 * 为什么要归一化：下游 finalScore = 0.7*sim + 0.2*fresh + 0.1*imp，
 * sim 的历史量纲是 coverage ∈ [0,1]（simGate/alpha/历史基线都按它标定）。
 * BM25 原始分是无界正数，直接塞进去会把 simGate 和权重全废掉。
 * 除数是「同一批查询 gram 全部 tf→∞ 时的上界」Σ_idf(g)*(k1+1)，
 * 所以 1.0 = 查询里每个 gram 都在文档里高频出现，语义与 coverage=1 对齐。
 *
 * @param {object} p
 * @param {Map<string, number>} p.tf     scanGrams/countQueryTf 的结果
 * @param {number} p.dl                  该文档 token 数
 * @param {number} p.avgdl               平均 token 数
 * @param {Iterable<[string, number]>} p.weights  gram → idf（同一次查询内算好）
 * @param {{k1:number,b:number}} [p.cfg]
 * @returns {number} ∈ [0,1]
 */
export function bm25Score({ tf, dl, avgdl, weights, cfg = BM25_DEFAULTS }) {
  let num = 0;
  let den = 0;
  const k1 = Number.isFinite(cfg.k1) ? cfg.k1 : BM25_DEFAULTS.k1;
  for (const [g, idf] of weights) {
    if (!(idf > 0)) continue;
    den += idf * (k1 + 1);
    const f = tf.get(g) || 0;
    if (f > 0) num += idf * bm25Tf(f, dl, avgdl, cfg);
  }
  if (!(den > 0)) return 0;
  const v = num / den;
  return v > 1 ? 1 : (v < 0 ? 0 : v);
}

/**
 * 一批候选的 gram 词频表：只在调用方需要 tf 时才算。
 * 返回 Map<docIdx, Map<gram,tf>>。
 *
 * @param {object[]} docs
 * @param {number[]} ids 候选下标
 * @param {Iterable<string>} qGrams
 */
export function tfsFor(docs, ids, qGrams) {
  const out = new Map();
  const w = qGrams instanceof Set ? qGrams : new Set(qGrams || []);
  if (!w.size) return out;
  for (const id of ids) {
    const d = docs[id];
    if (!d) continue;
    out.set(id, scanGrams(d.text, w).tf);
  }
  return out;
}
