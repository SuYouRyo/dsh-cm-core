// 24h 近似去重（项目单 5b）。
//
// 问题：库里只按 id 去重。同一句话换个会话 id 会被重灌一遍，
// recall 取前 5 条时看到的是同一件事的 5 个副本。这里按**内容指纹**在
// 24 小时窗口内判重。
//
// 归一化规则是项目单写死的，不许含糊（"该去的没去、不该去的被误杀"两种错都从这里来）：
//   做  ：trim、空白折叠、全角→半角、大小写统一、剥离首尾标点
//   不做：改动正文内容、删除表情/链接/话题标签（这些是内容的一部分）
//
// 另外三条同样是项目单原文，代码里必须能对应上：
//   · 时间边界按**记录自身时间戳**算（不按处理时刻），并给时钟漂移留余量；
//   · 只对**同 src** 生效（同 src 才可能是重复灌入，跨 src 是合法并存）；
//   · 删除后重发要给豁免（`dedupeExempt` / `meta.redo` / `CM_DEDUPE_EXEMPT`）。
//
// 设计取舍（为什么是"归一化 + 精确指纹"而不是 fuzzy）：
//   本项目的话很短（"想去看海""加班到三点"），编辑距离/相似度阈值在短句上
//   假阳性极高——「今天加班」和「明天加班」只差 1 个字，意思相反。
//   所以默认路径是**归一化后精确指纹**：跨会话同一句话必然同指纹（这是 5b 要解决的问题），
//   而不同的话不会被误杀。模糊相似度放在 `nearText()` 里，供调用方显式开启（默认关）。

import crypto from 'node:crypto';

/** 默认窗口：24 小时。 */
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 时钟漂移容忍：窗口两侧各多放 5 分钟，避免"刚好差 24h+3s"这种边界抖动。 */
export const CLOCK_DRIFT_MS = 5 * 60 * 1000;
/** 指纹算法版本。归一化规则或哈希改了就必须升版本，否则新旧指纹会混着比。 */
export const FINGERPRINT_VERSION = 1;
/** 指纹索引的软上限：超过只告警（暴露给调用方），不静默丢功能。 */
const MAX_INDEX_ENTRIES = 200000;

/**
 * 全角 → 半角。
 * 覆盖 U+FF01–U+FF5E（ASCII 全角变体）和 U+3000（表意空格）。
 * 中文标点（，。！？）也在 FF 段里，会一并变成 , . ! ? —— 这是归一化，不是改内容：
 * 存库的正文是原始 `rec.text`，变的只有指纹。
 */
export function toHalfWidth(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 0x3000) out += ' ';
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else out += ch;
  }
  return out;
}

// 只剥首尾的**标点**（\p{P}）。刻意不含 \p{S}（符号/表情）：
// 项目单要求「不删除表情」——表情常出现在句首句尾，剥掉就等于改了内容。
const EDGE_PUNCT = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/**
 * 指纹用的归一化。存库的正文不受影响。
 * 顺序：全角→半角 → trim → 空白折叠 → 大小写统一 → 剥离首尾标点 → 再 trim。
 * @param {string} text
 * @returns {string} 归一化结果（可能为空串，例如整段都是标点）
 */
export function normalizeText(text) {
  let s = toHalfWidth(String(text ?? ''));
  s = s.trim();
  // 空白折叠：连续空白（含换行、制表、全角空格）压成一个半角空格。
  s = s.replace(/\s+/g, ' ');
  // 大小写统一：只影响指纹，原始大小写仍存在正文里。
  s = s.toLowerCase();
  // 剥离首尾标点；剥完可能又露出空白，所以循环到不再变化。
  for (let i = 0; i < 4; i++) {
    const next = s.replace(EDGE_PUNCT, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/**
 * 内容指纹。空/纯标点文本返回 null（没有可比的"内容"，就不能判重）。
 * @param {string} text
 * @returns {string|null} 16 位十六进制
 */
export function fingerprint(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  return crypto.createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 16);
}

/** 从一条记录里取指纹。文本过长时只取前 4000 字（与 store 的截断上限一致）。 */
export function fingerprintOf(rec) {
  return fingerprint(String(rec?.text ?? '').slice(0, 4000));
}

/**
 * 归一化后的词面 bigram 集合。给 nearText 用，也给测试对照。
 * 与 search.js 的 gramsOf 同源规则（中文 2 字滑窗、英文整词），但这里不需要索引。
 */
export function normGrams(norm) {
  const out = new Set();
  const SEP = /[^\p{L}\p{N}]+/u;
  for (const seg of String(norm || '').split(SEP)) {
    if (!seg) continue;
    const chars = [...seg];
    // 汉字/假名/谚文按 2 字滑窗；拉丁字母数字整段算一个 gram（已由 SEP 切好）。
    const isCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(seg);
    if (!isCjk) { out.add(seg); continue; }
    if (chars.length === 1) out.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

/**
 * 归一化后的包含度（0..1）：交集 / 较短的那个集合。
 * **默认不参与判重**，只在调用方显式要"近似"时才用：短句上假阳性太高。
 */
export function nearText(a, b) {
  const A = normGrams(normalizeText(a));
  const B = normGrams(normalizeText(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * 窗口索引。纯内存、纯函数式（不碰 IO），由调用方（store.js）喂数据。
 *
 * 键是 `src + '\u0000' + fp`，所以**跨 src 天然不会互相命中**——
 * "只对同 src 生效"这条不是靠调用方自觉，是键里就带着 src。
 */
export function createDedupeIndex({ windowMs = DEDUPE_WINDOW_MS, driftMs = CLOCK_DRIFT_MS, maxEntries = MAX_INDEX_ENTRIES } = {}) {
  const map = new Map(); // key -> number[] （该指纹出现过的记录自身时间戳）
  const span = Math.max(0, windowMs) + Math.max(0, driftMs);
  let overflow = false;

  const keyOf = (src, fp) => `${src || 'chat'}\u0000${fp}`;

  /** 这个指纹在 [t-span, t+span] 内出现过吗？按记录自身时间戳算，不看处理时刻。 */
  function has(src, fp, t) {
    if (!fp) return false;
    const times = map.get(keyOf(src, fp));
    if (!times) return false;
    const tt = Number(t);
    if (!Number.isFinite(tt)) return false;
    for (const t0 of times) {
      if (Math.abs(tt - t0) <= span) return true;
    }
    return false;
  }

  /** 记一笔。超上限时置 overflow（调用方要能看见，不许静默失效）。 */
  function add(src, fp, t) {
    if (!fp) return false;
    const tt = Number(t);
    if (!Number.isFinite(tt)) return false;
    const k = keyOf(src, fp);
    let times = map.get(k);
    if (!times) {
      if (map.size >= maxEntries) { overflow = true; prune(Date.now()); if (map.size >= maxEntries) return false; }
      times = [];
      map.set(k, times);
    }
    times.push(tt);
    return true;
  }

  /** 丢掉整窗口外的条目，内存不随库增长而无限涨。 */
  function prune(now = Date.now()) {
    for (const [k, times] of map) {
      const keep = times.filter((t) => Math.abs(now - t) <= span);
      if (!keep.length) map.delete(k);
      else if (keep.length !== times.length) map.set(k, keep);
    }
    return map.size;
  }

  return {
    windowMs,
    driftMs,
    span,
    has,
    add,
    prune,
    reset() { map.clear(); overflow = false; },
    get size() { return map.size; },
    get overflow() { return overflow; }
  };
}

/** 解析豁免参数：`all` / `*` 全豁免；含 `:` 的当 id；其余当 src。 */
export function parseExempt(raw) {
  const out = { all: false, srcs: new Set(), ids: new Set() };
  const s = String(raw ?? '').trim();
  if (!s) return out;
  if (s === '*' || /^all$/i.test(s)) { out.all = true; return out; }
  for (const token of s.split(',')) {
    const tok = token.trim();
    if (!tok) continue;
    if (tok === '*' || /^all$/i.test(tok)) out.all = true;
    else if (tok.includes(':')) out.ids.add(tok);
    else out.srcs.add(tok);
  }
  return out;
}

/**
 * 从环境变量读配置。
 * 为什么用环境变量而不是命令行参数：`bin/cm.js` 是 Lead 的地盘，本作业不改它，
 * 所以"启动参数"这一条先用环境变量实现；命令行开关（--no-dedupe）留给 Lead 一处接线。
 *
 *   CM_NO_DEDUPE=1           整体关掉去重
 *   CM_DEDUPE_WINDOW_H=24    窗口小时数
 *   CM_DEDUPE_DRIFT_MS=300000 时钟漂移余量
 *   CM_DEDUPE_EXEMPT=...     豁免（all / src,src / id,id）
 */
export function dedupeConfigFromEnv(env = process.env) {
  const off = /^(1|true|yes|on)$/i.test(String(env?.CM_NO_DEDUPE ?? '').trim());
  const hours = Number(env?.CM_DEDUPE_WINDOW_H);
  const drift = Number(env?.CM_DEDUPE_DRIFT_MS);
  return {
    enabled: !off,
    windowMs: Number.isFinite(hours) && hours > 0 ? hours * 3600_000 : DEDUPE_WINDOW_MS,
    driftMs: Number.isFinite(drift) && drift >= 0 ? drift : CLOCK_DRIFT_MS,
    exempt: parseExempt(env?.CM_DEDUPE_EXEMPT),
    source: 'env'
  };
}

/** 这条记录是否被豁免（删除后重发的合法路径）。 */
export function isExempt(rec, exempt) {
  if (!exempt) return false;
  if (exempt.all) return true;
  // 记录级豁免：调用方明确知道这是用户重发的，就别判重。
  if (rec?.dedupeExempt === true) return true;
  if (rec?.meta?.redo === true) return true;
  if (exempt.ids?.size && rec?.id && exempt.ids.has(rec.id)) return true;
  if (exempt.srcs?.size && exempt.srcs.has(rec?.src || 'chat')) return true;
  return false;
}

/** 一条记录此刻算不算重复。给 store.append 用，抽出来是为了能被单测直接覆盖。 */
export function isDuplicate(index, rec, fp) {
  if (!index || !fp) return false;
  return index.has(rec?.src || 'chat', fp, rec?.t);
}
