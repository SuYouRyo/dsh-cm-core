// 关闭通道（close channel）—— W11，2026-11-09。
//
// 上游参考：洛灯鱼《陪伴型个人 agent 的真长期记忆系统》（小黑盒，2026-10-27，非开源）
//   §二原话：「一句『我感冒好了』经常**不产生任何新记忆**，但它必须能结束旧的『感冒了』。
//   如果关闭信息挂在每条记忆内部，**零条记忆的场景就永远关不掉**。所以它是一条独立通道，
//   在记忆循环之外执行。」
//
// 我们的洞：`markVoided(dir, id, ...)` 必须**给 id**。所以「他感冒好了」若没产出任何新印象/
// 新候选，就没有 id 可关，旧印象会一直活着。这与 U1 同源但更底层——不是「旧值排序靠前」，
// 是「根本没有入口能关掉它」。
//
// 本模块只做两件只读的事：
//   ① findCloseCandidates(dir, text) —— 从一句「好了」找出「该关哪几条」
//   ② 由调用方（CLI / AI）确认后，再走既有的 markVoided —— 本模块**不写库**
//
// 为什么不直接关：
//   「我感冒好了」也可能关掉「他今天很难受」这条不该关的。关错比没关更贵（voided 是终态，
//   不可撤销）。所以这里永远只**列候选 + 给理由**，写由人/AI 确认后调 markVoided。
//
// 红线：只读、不写库、不调模型、不联网；scope 门照旧（visibleScopes）。

import { collapse, loadImpressions, weightOf } from './impressions.js';
import { visibleScopes, SCOPE_SHARED } from './shared.js';

/** 「好了/结束了/不去了/改主意了」这类**关闭信号**。命中才启用候选搜索。 */
const CLOSE_SIGNALS = [
  /好了|好啦|已经好|痊愈|没事了|不难受|不疼了/,
  /不去了|不做了|取消了|改了|改主意|算了|不打算/,
  /过期|结束了|完事了|过去了|不再|别了|不用了/,
  /已经(?:办完|完成|结束|过去)/
];

/** 从关闭句里挑「要关的是哪件事」的关键词：去掉关闭信号词与虚词。 */
const STOP = new Set(
  ('好了 啦 已经 好 没事 不 难受 疼 了 的 吧 呢 吗 啊 我 他 她 你 就 都 也 又 还 在 是 有 会 要 想 说 给 ' +
   '去 做 取消 改 主意 算 打算 过期 结束 完事 过去 不再 别 用').split(' ')
);

/** 粗粒度停用词（中文两字功能词），避免「今天」这类把候选拉爆。 */
const WEAK = new Set(['今天', '昨天', '明天', '现在', '刚才', '然后', '但是', '因为', '所以', '如果', '就是', '可以', '什么']);

/**
 * 这句话是不是「关闭信号」。
 * @param {string} text
 * @returns {{ signal: boolean, terms: string[] }} terms＝从该句提取的检索词
 */
export function closeSignalOf(text) {
  const t = String(text || '').trim();
  if (!t) return { signal: false, terms: [] };
  const signal = CLOSE_SIGNALS.some((re) => re.test(t));
  if (!signal) return { signal: false, terms: [] };

  // 中文按字符二元组切，再过滤关闭信号词与功能词
  const chars = [...t.replace(/[\s\p{P}]+/gu, '')];
  const grams = new Set();
  for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i] + chars[i + 1]);
  const terms = [...grams].filter((g) => !STOP.has(g) && !WEAK.has(g) && g.length >= 2);
  return { signal: true, terms };
}

/**
 * 从一句关闭句找出「可能该关掉的」印象候选。**只读，不写。**
 *
 * @param {string} dir
 * @param {string} text        用户这一轮说的话（如「我嗓子已经好了」）
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.limit=5]
 * @returns {{ signal:boolean, terms:string[], candidates:{id,text,score,tag,scope,why}[] }}
 */
export function findCloseCandidates(dir, text, { now = Date.now(), limit = 5 } = {}) {
  const { signal, terms } = closeSignalOf(text);
  const out = { signal, terms, candidates: [] };
  if (!signal || !dir) return out;

  let live = [];
  try {
    const visible = visibleScopes();
    live = collapse(loadImpressions(dir))
      .filter((f) => f && f.id && !f.archived && !f.voided)
      .filter((f) => visible.includes(f.scope || SCOPE_SHARED));
  } catch {
    return out;   // 库读不了就当没有候选，绝不抛
  }

  const scored = [];
  for (const imp of live) {
    const body = String(imp.text || '');
    if (!body) continue;
    // 词面命中数（用同一套二元组口径，避免「按字面搜不到」的口径分裂）
    const bodyChars = [...body.replace(/[\s\p{P}]+/gu, '')];
    const bodyGrams = new Set();
    for (let i = 0; i + 1 < bodyChars.length; i++) bodyGrams.add(bodyChars[i] + bodyChars[i + 1]);

    let hit = 0;
    const hitTerms = [];
    for (const t of terms) if (bodyGrams.has(t)) { hit++; hitTerms.push(t); }
    if (!hit) continue;

    // 分数：命中词数为主，权重与「状态类」次之。
    // 为什么状态类加权：该关的通常是「今天感冒了 / 计划周三去」这类**有时效的判断**，
    // 而不是「他不吃香菜」这种长期偏好。关闭信号配状态类命中，可信度高得多。
    const w = weightOf(imp, now);
    const stateish = ['event', 'plan', 'status', 'emotion'].includes(String(imp.tag || '')) ? 1 : 0;
    const score = hit + stateish * 0.5 + Math.min(1, w / 3) * 0.3;
    scored.push({
      id: imp.id,
      text: body,
      score: Number(score.toFixed(3)),
      tag: imp.tag || 'misc',
      scope: imp.scope || SCOPE_SHARED,
      why: `命中 ${hit} 词（${hitTerms.slice(0, 4).join('/')}）${stateish ? ' + 状态类' : ''}`,
      voidable: true
    });
  }

  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  out.candidates = scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
  return out;
}

/**
 * 把候选渲染成「人/AI 能确认」的一小段文本。**不写库。**
 * 格式刻意给 id，方便确认后直接 `cm close --id`。
 */
export function renderCloseCandidates(result, { max = 5 } = {}) {
  if (!result || !result.signal) return '';
  if (!result.candidates.length) {
    return `「${result.terms.slice(0, 4).join('/') || '这句'}」像是关闭信号，但库里没有对得上的印象。`;
  }
  const lines = result.candidates.slice(0, max).map((c, i) =>
    `${i + 1}. [${c.id}] ${c.text}（${c.tag} · ${c.why}）`);
  return [
    '这句像在「关闭某件旧事」。可能该关的是下面几条，请确认（确认后用 cm close --id <id> 作废）：',
    ...lines
  ].join('\n');
}
