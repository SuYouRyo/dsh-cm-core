// 按预算装包（budget-driven pack）—— 逐字等价移植灵枢 LINGSHU 的确定性估算器与装包循环。
//
// 上游：https://github.com/FuRongJun-1999/dsh-memory  (MIT, © 2026 FuRongJun-1999)
//   md_cg/mdcos.py:243-256   est_tokens / _tokens_from_counts
//   md_cg/mdcos.py:258-286   excerpt_tokens
//   md_cg/mdcos.py:2898-2928 recall 装包循环（#562 / #637 之后的版本）
//
// 为什么借这一段：bench/report-20261108-714.md 的 64 道失分题里，41 道是
// 「材料齐仍答错」——原文在库里、检索也命中了，是**装包/作答侧**用 400 字硬截断
// 把答案本身切掉，或遇到一条超长材料就停下不再看后面的。灵枢给的是：
//   · 确定性 token 估算（不联网、不调模型、不是任何模型的 tokenizer）
//   · 超预算时先试「摘录纳入」并标 truncated
//   · 实在放不下才 continue 跳过、继续尝试更小的（不是 break）
//   · 返回体带 skipped / tokensUsed，让调用方知道丢了什么
//
// 移植原则（与 src/rank.js 一致）：**只搬算法，不搬依赖、不搬门限**。
//   · Python 全部改写成纯 JS 标准库，零第三方依赖。
//   · 灵枢的 DEFAULT_BUDGET=1200 / DEFAULT_MAX_ITEM_TOKENS=250 是**它自己标定的**
//     （docs/mdcg/记忆操作系统_MdCGOS与MCP接入_v0.1.md:140），
//     按协作约定硬纪律 3「门限不许抄，必须自己标定」，这里只给**可传入的默认值**，
//     不冒充已标定；调用方应显式传自己的预算。
//   · est_tokens 是**估算公式**不是门限，可逐字等价（CJK 0.6/字 + 其余 /4 +1）。
//   · 不改 src/search.js 的 maxChars=400 历史契约（外部脚本按它对齐），
//     不改 src/index.js 链路，不改 tests/run.mjs。
//
// 边界（docs/eval/excerpt_budget_20261012.md:7「可信边界」如实带来）：
//   est 是估算器，不是任何模型的 tokenizer；别拿它做精确计费。
//   更充分用预算会压缩后续低排名材料空间，调用方需自己守住 top 材料。

/** 确定性 token 估算：CJK 0.6/字 + 其余 /4，固定 +1 只计一次。
 *  逐字等价 md_cg/mdcos.py:243-256。 */
export function estTokens(text) {
  const s = text == null ? '' : String(text);
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  const other = [...s].length - cjk;
  return Math.floor(cjk * 0.6 + other / 4) + 1;
}

/** 按 est_tokens 口径截取正文前 maxTokens 的摘录；放不下时返回「前缀 + …」。
 *  逐字等价 md_cg/mdcos.py:258-286（含「空白字符不推进 keep」与固定 +1 只计一次）。 */
export function excerptTokens(text, maxTokens) {
  const s = text == null ? '' : String(text);
  if (!s || !(maxTokens > 0)) return '';
  if (estTokens(s) <= maxTokens) return s;   // 已足够小，原样返回（不放大）
  const ELLIPSIS = '…';
  const chars = [...s];
  let cjk = 0, other = 0, keep = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
    else other++;
    // 空白：计入计数但不推进 keep；内部空隙在后面放得下非空白时仍会被收进来
    if (/\s/.test(ch)) continue;
    // 省略号属于「其余字符」，整体估算里的固定 +1 只计一次
    if (Math.floor(cjk * 0.6 + (other + 1) / 4) + 1 > maxTokens) break;
    keep = i + 1;
  }
  return chars.slice(0, keep).join('') + ELLIPSIS;
}

/**
 * 按预算装包。
 *
 * @param {Function} readFn  (id) => string | {text:string} | null；按 id 回读完整原文。
 *                            ours: recall.read(id).event.text / .event（见 src/search.js:286）
 * @param {Array<string>} ids 已排好序的 id 列表（顺序＝重要性，先来的优先装）
 * @param {object} [opts]
 * @param {number} [opts.budget=2400]     总预算（est 口径）。⚠️ 生产默认 2400/150 由电脑端
 *        2026-11-09 拍板：真实库 12216 条中 31.08% 超 400 字、累计被截 261 万字；
 *        Monte Carlo 4000 次全装率 95.9%（800/0 仅 14.1%）；真实库 A/B n=97
 *        答案片段可见 1/97 → 60/97。⚠️ 714 卷测不出差别（原文 max 286 字，>400 为 0）。
 *        库层 API（recallVec）默认仍走 400 字历史契约，bench packets / 650-714 基线不动。
 * @param {number} [opts.maxItem=150]      单条摘录上限；0 = 关闭摘录、超出即跳过
 * @returns {{pack:Array, tokensUsed:number, budget:number, skipped:Array}}
 *          pack 每项 {id, text, tokens, truncated}
 */
export function packByIds(readFn, ids, { budget = 2400, maxItem = 150 } = {}) {
  const B = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  const M = Number.isFinite(maxItem) && maxItem > 0 ? Math.floor(maxItem) : 0;
  const minExcerpt = M ? Math.max(1, Math.min(50, Math.floor(M / 5))) : 0;
  const out = { pack: [], tokensUsed: 0, budget: B, skipped: [] };
  if (!B || !Array.isArray(ids) || typeof readFn !== 'function') return out;

  for (const id of ids) {
    let raw;
    try { raw = readFn(id); } catch (e) {
      out.skipped.push({ id, tokens: 0, reason: 'read_failed', error: String(e.message || e) });
      continue;
    }
    // 形状兼容（交接件 A4）：我们 src/search.js:286 的 read(id) 返回
    // {ok:true, event:{text,...}}；也吃 string / {text} / {event:{text}}。
    // 不认识的形状按空串处理，不抛错（fail-soft）。
    let content;
    if (raw == null) content = '';
    else if (typeof raw === 'string') content = raw;
    else if (typeof raw === 'object') {
      if (raw.ok === false) {
        out.skipped.push({ id, tokens: 0, reason: 'read_failed', error: String(raw.reason || 'not found') });
        continue;
      }
      const ev = raw.event && typeof raw.event === 'object' ? raw.event : raw;
      content = String(ev.text ?? raw.text ?? '');
    } else content = String(raw);
    let t = estTokens(content);
    let text = content;
    let truncated = false;

    if (out.tokensUsed + t > B) {
      // 超预算：优先纳入「前 N token 摘录」，而不是直接丢弃。
      // 灵枢 :2907-2909 自己承认旧行为（跳过超大）会系统性排除最有价值的详实条目。
      const room = B - out.tokensUsed;
      if (M && room >= minExcerpt) {
        const keep = Math.min(M, room);
        text = excerptTokens(content, keep);
        t = estTokens(text);
        if (t <= 0) {
          out.skipped.push({ id, tokens: 0, reason: 'excerpt_empty' });
          continue;
        }
        truncated = true;
      } else {
        out.skipped.push({ id, tokens: t, reason: 'oversize_or_over_budget' });
        continue;   // 跳过，继续尝试更小的（不是 break）
      }
    }
    out.pack.push({ id, text, tokens: t, truncated });
    out.tokensUsed += t;
  }
  return out;
}
