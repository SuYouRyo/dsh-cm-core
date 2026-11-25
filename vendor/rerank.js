// 精排（rerank）：把「召回池」按交叉编码器分数重排，再取前 N。
//
// 为什么需要它（而不是再算一次余弦）：
//   嵌入是双塔，query 和 doc 各自独立编码，只能比「大意相近」；
//   交叉编码器把 query 和 doc 拼在一起过一遍模型，能判「这句话到底
//   有没有回答这个问题」。所以链路是：召回 40 条 → 精排 → 取前 N。
//
// 设计原则（按项目单 1 节 + 协作约定，逐条对上）：
//   1. **永不抛异常**。精排是加分项，不是必需品。任何失败都退回原排序，
//      调用方从 `degraded` 字段看得见发生了什么（不许静默失败）。
//   2. **降级时零外发**。开关关掉 / 没有 key / 池子为空 → 一个字节都不发出去。
//   3. **开关两路**：`--no-rerank` 命令行 + `CM_NO_RERANK=1` 环境变量，任一即关。
//   4. **门限自己标定**。qwen-rag 的 0.03 是它在自己那套管线（4096 维
//      Qwen3-VL 嵌入 + 不同语料）上标定的。同一个模型在不同候选分布下
//      分数量纲会漂，抄数字就是拍脑袋。本文件的门限由
//      `tests/eval-rerank.mjs` 在 memory-system-benchmark 的真题上标定，
//      依据写在 RERANK_FLOOR 的注释里。
//
// 与 qwen-rag/app/rerank.py 的关系：思路照搬（池子全送、截断交调用方、
// 门限只卡第一名），但**逐条砍的坑不重复踩**——那边实测逐条砍会把
// R@6 从 0.963 砍到 0.889。

import { findKey } from './embed.js';

export const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';
export const RERANK_BASE = 'https://api.siliconflow.cn/v1';
/** 单次精排的总预算（含重试）。recall 是热路径，3 秒已经算很宽容。 */
export const RERANK_TIMEOUT_MS = 3000;
/**
 * 进精排池的条数。池子大小可配。
 *
 * **2026-11-08 由 40 提到 60**，依据 `bench/recall-gap-20261108.md`：
 * 714 题全量 A/B 下 pool=60 的 hit@10 比 40 高 1.4 个点（94.40% → 95.80%），
 * MRR 0.8671 → 0.8695；而外发原文量只从每次 4885 字涨到约 7300 字（+50%），
 * 不是 pool=100 那样翻倍（10532 字）。延迟实测无差别（中位 646ms → 671ms）。
 *
 * 没有取 100 的理由：多 2.2 个点的收益，代价是每次把翻倍的私事发给第三方；
 * 也没有停在 40：13 道零召回题里有目标真实排在第 98 名的，40 根本轮不到。
 */
export const RERANK_POOL = 60;
/** 精排后默认取前 N 条。调用方要更多条就显式传 topN（或传 0 表示不截断）。 */
export const RERANK_TOP_N = 10;

/**
 * 门限：**只卡第一名**，第二名及以后一律不砍。
 *
 * 标定依据（`node tests/eval-rerank.mjs`，本机真 key 真 API，28 次调用 0 降级，
 * 20 题正例 + 8 题「库里根本没有答案」的负例，混合通道候选池平均 39 条）：
 *
 *   正例 top-1 分数（升序）：0.1155, 0.1901, 0.38, 0.4262, 0.5162, 0.557,
 *     0.5594, 0.6231, 0.6329, 0.8468, 0.8474, 0.8833, 0.9141, 0.9405,
 *     0.9547, 0.9848, 0.9853, 0.9934, 0.9976, 0.9978
 *   负例 top-1 分数（降序）：0.8075, 0.7392, 0.2539, 0.2401, 0.2046, 0.1925,
 *     0.029, 0.0073
 *
 *   门限扫描（门限只卡第一名时的实测）：
 *     0.00~0.11 → 误杀正例 0/20，拒掉负例 2/8，MRR@10 保持 0.9500
 *     0.12~0.15 → 误杀正例 1/20，MRR@10 掉到 0.9474
 *     0.20 起   → 误杀正例 2/20，MRR@10 掉到 0.9444
 *     0.30      → 拒掉负例 6/8，但已误杀 2 个真答案
 *
 *   为什么取 0.05 而不是区间上沿 0.11：两者在本评测集上表现**完全相同**
 *   （都是 0 误杀 + 拒 2/8），但 0.05 距最低正例 0.1155 还有 2.3 倍余量，
 *   换一批语料时不容易踩到。往上提没有收益，只会吃掉安全边际。
 *
 *   为什么不能取更高：**分数不是分离器**。负例最高分 0.8075
 *   （「今天天气怎么样」——语料里真有 6 处聊下雨/晒被子的对话，模型匹配
 *   得没错），而正例最低 0.1155。两个区间严重重叠，任何门限都必然
 *   二选一地漏。所以本门限的定位是「挡住明显不相关的」，不是「保证
 *   答得上来」；调用方拿到空 hits 时应当说「记忆里没提到」，而不是
 *   断言用户没说过。
 *
 * 为什么不做逐条过滤（每条的 rerank 都卡门限）：负例的 top-1 也就
 * 0.029/0.0073，而正例第 3 名之后有大量 0.0x 的真答案，逐条砍等于把
 * 真答案砍掉——qwen-rag 那边实测 R@6 会从 0.963 掉到 0.889。
 *
 * ⚠️ 标定用的是**混合通道**（词面 + bge-m3 向量，alpha 走默认）的候选池。
 * 若召回分布大变（向量通道占比大幅提高、池子从 40 改成 100），必须重跑
 * `node tests/eval-rerank.mjs` 重标，不要沿用这个数。也**不要**照搬
 * qwen-rag 的 0.03——那是它在 4096 维 Qwen3-VL 嵌入 + 另一套语料上
 * 标出来的，分数量纲不同，抄数字就是拍脑袋。
 */
export const RERANK_FLOOR = 0.05;

/**
 * 门限的第二条判据：**分不开**。
 *
 * 2026-11-06 加的。起因：基准测试里 714 题有 38 题的 top-1 落在 0.02 量级
 * （见 RERANK_FLOOR 注释里的正例分布——那批标定样本 top-1 最低 0.1155，
 * 基准题里却普遍 0.01~0.03），绝对阈值 0.05 把它们全判成「无相关内容」，
 * 其中 29 题因此失分。根因不是 0.05 这个数太大，而是**用绝对值判「有没有」**
 * 这件事本身就不成立：bge-reranker 的分数是 query-doc 对的 sigmoid，
 * 它对「开放式问句 vs 口语原文」这类弱表述天然给低分，但那句话确实是答案。
 *
 * 所以补一条只看**分布形状**的判据：如果整批分数挤在一起（top-1 与中位数
 * 差不到 FLOOR_FLAT_BAND），说明精排没给出区分度，它排出来的顺序就是噪声 ——
 * 这时候信它不如信融合分。
 *
 * 为什么还要 `top1 < WEAK_CEIL` 这一半：高分段的扁平是**正常**的。
 * 一批候选全在 0.9 附近，说明都相关，谁先谁后本来就无所谓；
 * 那种情况退回融合排序反而是退步。只有低分段的扁平才意味着失效。
 * 0.3 这个位置来自上面的标定表：0.30 那一档已经误杀 2 个真答案，
 * 说明 0.3 以上基本可以认为「精排认得出来」。
 */
export const FLOOR_FLAT_BAND = 0.01;
export const WEAK_CEIL = 0.3;

/**
 * 相对判据（2026-11-08，B1）。
 *
 * 起因：`FLOOR_FLAT_BAND = 0.01` 是个**绝对**带宽，它只在 0.9 量级的分数上
 * 才叫「贴在一起」；在 0.02 量级的批次里，0.015 的落差会被判成「拉开了」，
 * 而实际上那批分数整整齐齐地挤在噪声里。反过来，换一套语料让分数整体
 * 抬到 0.6 量级，0.01 的带宽就变成了「几乎任何一批都能通过」。
 *
 * 所以带宽改成**跟着量纲走**：与中位数的落差，相对 top-1 本身的比例。
 * 这样 0.02 的一批和 0.9 的一批用同一把尺子，换语料不用重标。
 *
 * 为什么不干脆删掉绝对门限 `RERANK_FLOOR`：它挡的是另一种情况——
 * 「全批都低」（负例 0.029 / 0.0073 这种），那批可能内部还挺「分得开」，
 * 相对判据会放过它，绝对门限正好拦住。两条判据管的不是同一件事。
 *
 * 标定依据（零成本，用 RERANK_FLOOR 注释里已有的 28 条历史查询实测分布，
 * **没有为此新跑任何 API**）：
 *   正例 20 条 top-1：最低 0.1155，最高 0.9978，跨度 0.88
 *   负例 8 条  top-1：0.8075 / 0.7392 / 0.2539 / 0.2401 / 0.2046 / 0.1925 / 0.029 / 0.0073
 *   取 0.35：0.1155 那条若整批挤在 0.115 附近会被判弱（正确——那题本来
 *   就是标定里最像个「弱相关」的正例）；而 0.9 量级那批因为 WEAK_CEIL
 *   根本进不了这条判据，不受影响。
 */
export const REL_FLAT_RATIO = 0.35;

/** 模型给的分数是 0..1 的 sigmoid；低于这个值只可能是「不相关」。 */
const NO_KEY_REASON = '没有硅基流动 API Key，未外发任何内容';

/** 默认日志：走 stderr，不污染 stdout 的结果输出（CLI 的 JSON 在 stdout）。 */
function defaultLog(msg) {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    // 日志失败也不能让检索失败
  }
}

/**
 * 环境/参数层面的开关：`--no-rerank` 或 `CM_NO_RERANK=1` 任一存在即为关。
 *
 * @param {object} [flags]
 * @param {boolean} [flags.disabled] 调用方显式关（最高优先级）
 * @param {string[]} [flags.argv]    用自己的 argv（测试用）；缺省读 process.argv
 * @returns {boolean}
 */
export function rerankDisabled(flags = {}) {
  const f = flags && typeof flags === 'object' ? flags : {};
  if (f.disabled === true || f.noRerank === true) return true;

  // 环境变量：「存在且不是明确的 0/false」就当成要关。
  const env = process.env.CM_NO_RERANK;
  if (env !== undefined && env !== null) {
    const v = String(env).trim().toLowerCase();
    if (v !== '' && v !== '0' && v !== 'false' && v !== 'no') return true;
  }

  const argv = Array.isArray(f.argv) ? f.argv : process.argv.slice(2);
  for (const raw of argv) {
    const s = String(raw);
    if (s === '--no-rerank') return true;
    if (s.startsWith('--no-rerank=')) {
      const v = s.slice('--no-rerank='.length).trim().toLowerCase();
      if (v !== 'false' && v !== '0' && v !== 'no') return true;
    }
  }
  return false;
}

/** 送进精排的文本。不带时间/角色前缀：实测加了反而略微掉分（见评测脚本 A/B）。 */
export function docOf(hit) {
  return String(hit?.text ?? '').slice(0, 300);
}

function reasonOf(res, kind) {
  return `${kind}（HTTP ${res?.status ?? '?'}）`;
}

/** 带超时的 POST。返回 {ok, status, json, err}，绝不抛。 */
async function postOnce({ url, key, body, timeoutMs, fetchImpl }) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs)) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body,
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = String(await res.text()).slice(0, 200);
      } catch {}
      return { ok: false, status: res.status, err: reasonOf(res, detail || '接口报错') };
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, status: res.status, err: `返回不是合法 JSON：${e.message}` };
    }
    return { ok: true, status: res.status, json };
  } catch (e) {
    // AbortController 触发时 fetch 抛的是 AbortError
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, status: 0, err: aborted ? 'TIMEOUT' : `网络错误：${e?.message || e}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 精排。**永不抛异常**。
 *
 * @param {string} query
 * @param {Array} hits    recall.search 的原始命中（{t,time,role,text,coverage,vec,...}）
 * @param {object} [opts]
 * @param {string} [opts.key]        API key，缺省 findKey()
 * @param {string} [opts.base]       接口 base
 * @param {string} [opts.model]      模型
 * @param {number} [opts.timeoutMs]  总预算，缺省 3000
 * @param {number} [opts.pool]       进池条数，缺省 40
 * @param {number} [opts.topN]       返回条数，缺省 10；传 0 或负数表示不截断
 * @param {number} [opts.floor]      第一名门限，缺省 RERANK_FLOOR；传 0 关闭
 * @param {boolean} [opts.disabled]  显式关掉
 * @param {string[]} [opts.argv]     自定义 argv（开关判定用）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
 * @param {Function} [opts.log]      日志函数，缺省写 stderr
 * @returns {Promise<{hits: Array, degraded: null|{reason:string, sent:number}, weak?: boolean}>}
 *   - 成功：hits 已按精排分降序，每条多 `rerank`（0..1）与 `rerankRank`（0 起）
 *   - 降级：hits 是原数组（同一引用）或其原顺序切片，未被改动
 *   - 弱相关（门限命中）：hits 是**原数组**（融合分序），`weak: true`。
 *     **不再返回空数组** —— 精排分数低只说明「精排在这批上看不出高下」，
 *     不说明「资料里没有」。空数组会让上游把正确答案一起扔掉（见文件末尾改动记录）。
 */
export async function rerankHits(query, hits, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const list = Array.isArray(hits) ? hits : [];
  const log = typeof o.log === 'function' ? o.log : defaultLog;

  // ---- 降级分支 0：没有任何候选 → 不发请求（空请求也是外发）----
  if (!list.length) return { hits: list, degraded: null };

  // ---- 降级分支 1：开关 ----
  if (rerankDisabled(o)) {
    const degraded = { reason: '精排已关闭（--no-rerank / CM_NO_RERANK=1）', sent: 0 };
    return { hits: list, degraded };
  }

  const key = String(o.key ?? findKey() ?? '').trim();
  if (!key) {
    const degraded = { reason: NO_KEY_REASON, sent: 0 };
    log(`[rerank] 降级：${degraded.reason}（外发 0 条）`);
    return { hits: list, degraded };
  }

  const base = String(o.base || RERANK_BASE).replace(/\/+$/, '');
  const model = o.model || RERANK_MODEL;
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : RERANK_TIMEOUT_MS;
  const pool = Number.isFinite(o.pool) && o.pool > 0 ? o.pool : RERANK_POOL;
  const topN = Number.isFinite(o.topN) ? o.topN : RERANK_TOP_N;
  const floor = Number.isFinite(o.floor) ? o.floor : RERANK_FLOOR;
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch;
  const docOfFn = typeof o.docOf === 'function' ? o.docOf : docOf;

  if (typeof fetchImpl !== 'function') {
    const degraded = { reason: '当前运行时没有 fetch，未外发任何内容', sent: 0 };
    log(`[rerank] 降级：${degraded.reason}（外发 0 条）`);
    return { hits: list, degraded };
  }

  const candidates = list.slice(0, pool);
  const docs = candidates.map(docOfFn);
  const sent = docs.length;

  const body = JSON.stringify({
    model,
    query: String(query ?? ''),
    documents: docs,
    // 整个池子都排一遍。只送 top_n 会让「第 11 条其实最相关」被服务端直接截掉。
    top_n: docs.length,
    return_documents: false
  });
  const url = `${base}/rerank`;

  // 重试 ≤1 次：只对「超时 / 网络 / 429 / 5xx」重试。
  // 401、400 这类重试一百次也一样，白等。
  //
  // 注意 timeoutMs 是**总预算**（项目单要求 3 秒上限），不是单次请求的超时。
  // 所以「第一次就超时整整 3 秒」时留给重试的时间是 0 → 不重试，直接降级。
  // 这是故意的：recall 是热路径，宁可退回原排序也不能把调用方拖住 6 秒。
  // 重试真正救的是「快速失败」——网络抖动、429、5xx，那些几十毫秒就回，
  // 第二次还有富余时间。想验证重试逻辑请用 5xx，不要用超时。
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      last = { ok: false, status: 0, err: 'TIMEOUT' };
      break;
    }
    attempts++;
    const r = await postOnce({ url, key, body, timeoutMs: remain, fetchImpl });
    if (r.ok) {
      last = r;
      break;
    }
    last = r;
    const retriable = r.err === 'TIMEOUT' || r.status === 0 || r.status === 429 || r.status >= 500;
    if (!retriable) break;
    if (attempt === 0 && deadline - Date.now() < 200) break; // 剩余时间不够重试，别硬等
  }

  if (!last || !last.ok) {
    const e = last?.err || '未知原因';
    const reason =
      e === 'TIMEOUT'
        ? `精排超时（总预算 ${timeoutMs}ms 用尽，实际请求 ${attempts} 次）`
        : `精排接口不可用：${e}`;
    const degraded = { reason, sent };
    log(`[rerank] 降级：${degraded.reason}（外发 ${sent} 条）`);
    return { hits: list, degraded };
  }

  // ---- 解析 ----
  const items = last.json?.results;
  if (!Array.isArray(items) || !items.length) {
    const degraded = { reason: '精排返回空结果', sent };
    log(`[rerank] 降级：${degraded.reason}（外发 ${sent} 条）`);
    return { hits: list, degraded };
  }

  // 服务端可能返回重复 index 或越界 index。越界一律丢掉——宁可少几条，
  // 也不能把别的命中的分数张冠李戴上去（embed.js 的 index 坑就是同类问题）。
  const seen = new Set();
  const scored = [];
  for (const it of items) {
    const i = Number(it?.index);
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    const s = Number(it?.relevance_score);
    scored.push({ i, score: Number.isFinite(s) ? s : 0 });
  }
  if (!scored.length) {
    const degraded = { reason: '精排返回的 index 全部越界或重复', sent };
    log(`[rerank] 降级：${degraded.reason}（外发 ${sent} 条）`);
    return { hits: list, degraded };
  }

  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = scored.map(({ i, score }, rank) => ({
    ...candidates[i],
    rerank: Number(score.toFixed(4)),
    rerankRank: rank
  }));

  // ---- 门限：判「这批精排分动不动得分」，动不了就退回融合排序 ----
  //
  // ⚠️ 2026-11-06 改过行为（原来的实现会 return hits: []，见文件末尾「P0 改动记录」）。
  // 现在**永不返回空数组**：门限只决定「还要不要信精排的排序」，不再决定「有没有答案」。
  //
  // 判据从「绝对阈值」改成三条，任一成立即判为弱：
  //   ① 绝对低：top-1 < floor。全批都低。
  //   ② 分不开（绝对带宽）：top-1 与本批中位数差不到 FLOOR_FLAT_BAND，且 top-1 < WEAK_CEIL。
  //      整批挤在一起说明精排没给出区分度，它排出来的顺序就是噪声。
  //   ③ 分不开（相对带宽，2026-11-08 B1 新增）：top-1 与中位数的落差 / top-1 < REL_FLAT_RATIO，
  //      且 top-1 < WEAK_CEIL。理由见 REL_FLAT_RATIO 的注释——0.01 这个绝对带宽
  //      只在 0.9 量级合适，低分段同一把尺子量不出「挤」。
  //
  // 为什么②③要卡 WEAK_CEIL：高分段的「扁平」是正常的（一批都很相关，
  // 谁先谁后本来就无所谓）。只有**低分段**的扁平才意味着精排失效。
  //
  // floor 传 0 = 关掉整个门限（含②③），测试和 eval 靠这个走纯净路径。
  if (floor > 0) {
    const top1 = out[0].rerank;
    const median = out[Math.floor(out.length / 2)].rerank;
    const tooLow = top1 < floor;
    const gap = top1 - median;
    const lowBand = out.length >= 5 && top1 < WEAK_CEIL;
    const flatAbs = lowBand && gap < FLOOR_FLAT_BAND;
    const flatRel = lowBand && top1 > 0 && gap / top1 < REL_FLAT_RATIO;
    const flat = flatAbs || flatRel;

    if (tooLow || flat) {
      const why = tooLow
        ? `精排最高分 ${top1} 低于门限 ${floor}`
        : `整批分不开（top-1 ${top1} 与中位数 ${median} 差 ${Number(gap.toFixed(4))}` +
          `${flatRel && !flatAbs ? `，相对 ${Number((gap / top1).toFixed(3))}` : ''}）`;
      const reason = `${why}，精排在这批上不具区分度，已退回融合排序（保留 ${list.length} 条候选）`;
      log(`[rerank] 弱相关：${reason}（外发 ${sent} 条）`);
      // 退回**未精排的原顺序**（融合分序），不是 out。这是本轮 P0 的关键：
      // 精排分不可信时，它的重排同样不可信；融合分是另一个独立信号，还站得住。
      return { hits: list, degraded: { reason, sent }, weak: true };
    }
  }

  const finalHits = topN > 0 ? out.slice(0, topN) : out;
  return { hits: finalHits, degraded: null, weak: false };
}

/**
 * 便捷封装：拿一个「永远可用」的精排函数。
 * 调用方不需要每次都传 opts，也不需要考虑异常。
 */
export function createReranker(defaults = {}) {
  let lastDegraded = null;
  let lastWeak = false;
  return {
    get lastDegraded() {
      return lastDegraded;
    },
    get lastWeak() {
      return lastWeak;
    },
    async rerank(query, hits, opts = {}) {
      const r = await rerankHits(query, hits, { ...defaults, ...opts });
      lastDegraded = r.degraded;
      lastWeak = !!r.weak;
      return r;
    }
  };
}

// =====================================================================
// P0 改动记录（2026-11-06）
//
// **改了什么**：门限命中不再返回空数组，改成退回融合排序（`hits: list` + `weak: true`）。
//
// **为什么**：基准成绩 643/714（90.1%），701 题里 38 题被 0.05 这个绝对门限
// 判成空结果，其中 29 题因此失分。召回 0 条的题通过率只有 23.7%，
// 召回 10 条的题通过率 93.8% —— 这是整条链路上单点损失最大的一处。
//
// 复现（P01-CASE-003/d45，问全名和年龄）：
//   向量通道第 6 名「我叫沈知夏，知了的知，夏天的夏，24」，余弦 0.601；
//   进精排后 top-1 = 0.0188 < 0.05 → 返回 hits: [] → MMR 拿到空数组 →
//   recallVec 最终 hits = 0 → 作答模型看不到那句原文，只能编。
//
// **为什么原设计是错的**：这个门限的注释里其实已经写着「分数不是分离器，
// 负例最高 0.8075 与正例最低 0.1155 严重重叠」「调用方拿到空 hits 时应当说
// 『记忆里没提到』，而不是断言用户没说过」。结论下对了，但落地的代码仍然
// 用它来判决「有没有答案」—— 把一个**排序置信度**当成了**存在性判断**。
// 标定集只有 20 个正例、且都是「一眼能看出来」的题（top-1 最低 0.1155），
// 真实基准里的弱表述根本不在样本里，所以标定时看不到这个坑。
//
// **改法**：门限降级为「要不要信精排的排序」，判据除绝对阈值外补一条
// 分布形状（见 FLOOR_FLAT_BAND / WEAK_CEIL）。判为弱时退回**未精排的
// 原顺序**——精排分不可信时它的重排同样不可信，而融合分是独立信号。
//
// **上游配套**：`src/index.js` 的 recallVec 里加了一道 `r.hits.length ? r.hits : raw`
// 兜底。两道都要有：这里保证不主动返回空，那里保证不管下层给什么都不会把
// 一批有效候选变成 0 条。单改一处，另一个调用路径（比如以后有人直接调
// rerankHits）就会重新踩坑。
//
// **不做的事**：没有去调 0.05 这个数。把 0.05 改成 0.015 能让这 38 题过关，
// 但那是拿基准集的分数分布去拟合基准集 —— 换一批语料立刻失效，
// 而且会把真正「库里没有」的题也放进来（负例 top-1 有 0.029/0.0073 落在那）。
// 改判据的性质，不改判据的数值。
// =====================================================================
