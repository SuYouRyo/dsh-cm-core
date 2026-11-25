// 情绪层 W13 · 正负向词表（2026-11-11 初版；2026-11-13 维修）
//
// 用途：
//   ① pleasure 轴的正/负向词密度计算（L0）
//   ② L2 心境一致算法的「条目倾向分」（W13-E 实现）
//
// 词表内容 **标「未标定，占位」**（W13-F 标定）。
// 维护权归**念与苏尤**，辞岸只提供初版候选 —— 这不是辞岸该替念定的东西。
//
// 只做正向/负向的词面计数，**不做语义理解、不调模型**。
//
// ================================================================
// 2026-11-13 维修（念实测报告 6 条中的第 4、5 条，苏尤「其他全修」）
//
// 原实现三处硬伤，实测数值见 docs/任务日志 与交付件：
//
//   ① **单字词纯子串匹配 → 大面积误伤**。原表 52 条里 17 条是单字：
//      好/棒/爱/赞/顺（正）＋ 烦/累/崩/气/糟/差/疼/痛/苦/烂/废/破（负）。
//      「今天天气不错」因为一个「气」被判负；「差不多就行了」因为「差」被判负；
//      「不好」因为「好」被判**正**。日常话几乎全中招。
//      → 本次**全部移除单字条目**，改成语素上不大可能误伤的双字/多字词。
//        只保留「累」这一个字作为例外是**不**做的——实测「累」单独出现时
//        确实几乎总是负向，但它和「积累」「累积」「连累」重码，宁可漏不误伤。
//
//   ② **没有否定处理**。「不太好」「不开心」「不累」全部按肯定算。
//      → 本次加一层：命中词前 1-3 字内出现否定词（不/没/无/别/未/莫/甭），
//        则该命中**不计入原方向**（不做「反向计分」——「不累」不等于「愉悦」，
//        它只是「没有负向」，按中性处理最保守）。
//
//   ③ **total 用「字符数 / 2」估词数 → 说得越细情绪越弱**。
//      实测「累」→ -1.000，「今天真的好累啊不想动了什么都提不起劲来」(19字) → -0.350。
//      同一件事说详细反而不触发，会训练出「倾向短促说话」的坏习惯。
//      → 本次 total 改为**「命中总数与 1 的较大者」**，即 *只按命中计密度*，
//        不再受文本长度稀释。语义：density = 命中数 / 分母，
//        分母取 max(1, positive+negative) 时，density 恒为「该方向占比」。
//        ⚠️ 这会改变 pleasure 的数值分布，属于行为变更，已登记在交付件 §变更影响。
//
// 为什么 total 不能直接用 `1`：`updateAxes()` 用的是
//   `pleasure += posDensity*0.5 - negDensity*3.5`
// 若 total=1，posDensity 就等于 posHits，正向命中 1 次即 +0.5，三步顶到上限。
// 用 `max(1, 命中总数)` 时 posDensity = posHits/(posHits+negHits) ∈ [0,1]，
// 单句里正负混杂会自然抵消，纯正向才推到 1 —— 这才是「密度」该有的语义。
// ================================================================

/** 正向词（愉悦信号）。初版候选，未标定。**已移除全部单字条目**（见文件头 ①）。 */
export const POSITIVE_WORDS = [
  // 正向另案第一步（2026-11-11）：
  //   ① 移除「谢谢」——它是关系/亲近信号，不是愉悦效价（D③ 第10句订正：愉悦 高→中）
  //   ② 去重「舒服」——原表出现两次，导致每出现一次被计 2 个正向命中
  // 2026-11-13：单字「好/棒/爱/赞/顺」全部换成不易误伤的多字词。
  '喜欢', '开心', '高兴', '不错', '厉害', '舒服',
  '满意', '哈哈', '可爱', '有趣', '优秀', '成了',
  '搞定', '成功', '太好了', '安心', '放心', '幸福', '温柔',
  // 替换原单字条目用的多字词（覆盖原来想表达的语感）
  '真好', '挺好', '很好', '好开心', '好棒', '很棒', '太棒',
  '爱你', '喜欢上', '点赞', '赞美', '顺利', '顺心',
  // 2026-11-13 三轮维修（念第 2 条）：**克制的正向词**。
  // 苏尤日常不爱用极端词，「还行」「凑合」就是他的「好」。
  // 只认「喜欢/开心/太好了」这套词表，等于只听得懂大起大落的表达，
  // 把日常的好全部读成中性 —— 这不是保守，是聋。
  '还行', '还可以', '凑合', '就那样', '一般吧'
];

/**
 * 词权重：默认 1，表里有的按值算。
 *
 * 为什么需要权重：念第 2 条要求「克制的正向词给轻微 pos」。
 * 二元计数只能表达「有/没有」，「还行」（0.5）和「太好了」（1.0）
 * 是两种不同强度的好，压成一个数就把苏尤的语气抹平了。
 *
 * ⚠️ 权重会进入 `positive`/`negative` 的总和，可能是小数；
 *    `emotion.js` 里 `posHits * 0.25` 的计算对小数天然成立，无需改动（红线不动）。
 */
export const WORD_WEIGHTS = {
  '还行': 0.5, '还可以': 0.5, '凑合': 0.5, '就那样': 0.5, '一般吧': 0.5
};

/**
 * 转折 / 递进连词：**含「不」字但不否定后面的词**。
 *
 * 2026-11-13 三轮维修（念第 1 条，她标了「极其重要」）：
 *   「不过」的「不」被判成否定词，把后面的「挺好」吃掉了；
 *   「不但」「不仅」「不光」同理 —— 它们是递进（"不但 A 还 B"），
 *   后面跟的全是**肯定**的褒义词。
 *
 * 处理方式：计数前把这几组词做等长占位替换，让「不」不再出现在
 * 否定词的回看窗口里。等长是为了不打乱后续命中的下标。
 *
 * ⚠️ 已知取舍：「不过分」这种「不 + 过分」的真否定也会被误判成转折。
 *    但「过分」不在词表里，「不」在这里没有可否定的目标，代价可忽略；
 *    而「不过/不但」作为连词的出现频率高一个数量级。
 */
export const ADVERSATIVE_WORDS = ['不但', '不仅', '不光', '不过'];

/** 负向词（不愉悦信号）。初版候选，未标定。**已移除大部分单字条目**（见文件头 ①）。 */
export const NEGATIVE_WORDS = [
  '难受', '讨厌', '难过', '失望',
  '焦虑', '失眠', '崩溃', '郁闷', '压抑', '火大', '无语', '委屈',
  '不甘', '后悔', '倒霉', '心累',
  // 替换原单字条目用的多字词
  '烦躁', '麻烦', '很烦', '好烦', '真烦',
  '好累', '很累', '太累', '累死', '疲惫', '疲劳',
  '崩溃了', '生气', '好气', '气死', '来气',
  '糟糕', '糟心', '很差', '太差', '差劲',
  '心疼', '疼痛', '头痛', '痛苦', '苦恼',
  '破烂', '烂透', '废了', '废物', '破防'
];

/**
 * 单字负向词 + 各自的「安全网」。
 *
 * 为什么还要留几个单字：`累` / `疼` / `痛` / `烦` 单独成句太常见了
 * （「累。」「疼。」「烦死了」），全删掉会漏掉最直白的信号。
 * 但它们又都是常见词的构件，所以给每个配**前置/后置排除字**：
 * 命中字紧邻的那一侧出现表里的任意一个字，就不算负向。
 *
 * 例：`累` 后置排除 加/赘（累加、累赘）、前置排除 积/计/连（积累、累计、连累），
 * 所以「我在积累经验」不会被判成疲惫；而「累」「好累」「累了」照常命中。
 */
export const SINGLE_CHAR_NEGATIVE = {
  // 字: { before: [紧邻其前的字], after: [紧邻其后的字] }
  //   积累/累计/连累/牵累 → 「累」在前或在后；累加/累赘 → 在后
  '累': { before: ['积', '连', '牵'], after: ['计', '加', '赘'] },
  '疼': { before: [], after: ['爱'] },          // 疼爱是正向，不能算痛
  '痛': { before: [], after: ['快', '饮'] },    // 痛快、痛饮
  '烦': { before: [], after: ['请', '琐'] }     // 烦请（客套）、烦琐（中性的「琐碎」）
};

/**
 * 否定词（出现即翻转该次命中的方向归属）。
 *
 * 只用单字 + 极少数高频双字，且**必须紧邻命中词**（间隔 ≤ NEG_WINDOW 个字），
 * 否则「我今天不开心但也不想说不好」这种句子里的跨段否定会乱翻。
 *
 * ⚠️ 2026-11-13 实测踩过的坑：**「别」和「非」不能当单字否定词**。
 *   「特**别**开心」会被判成「别+开心 = 不开心」，「区**别**」「告**别**」「分**别**」
 *   同理；「非」在「非常开心」里也全是正向。
 *   这类「否定字恰好是常见词的一部分」的字，用单字匹配得不偿失 —— 宁可漏掉
 *   「别哭」这一种，也不要误伤「特别」「非常」这两种高频词。
 *   要用的话只能放在多字词组里（见 NEGATOR_PHRASES）。
 */
const NEGATORS = ['不', '没', '无', '未', '莫', '甭'];
/**
 * 不能拆成单字用的否定短语（含上面被排除的「别」「非」）。
 * 只有整段命中才算否定，避免「特别」「非常」误伤。
 */
const NEGATOR_PHRASES = ['别太', '别这么', '别那么', '非但不'];
/** 否定作用的回看窗口（命中词前多少个字以内出现否定词即算被否定）。 */
const NEG_WINDOW = 3;

/**
 * 判断某个命中位置是否被前面的否定词否定。
 *
 * @param {string} s 已经做过占位替换的文本
 * @param {number} at 命中词起始下标
 * @param {Array<{at:number,len:number}>} [spans] 全部候选命中（含本次），
 *        用于判断否定词是不是「越过别的词」来否定本词
 * @returns {boolean}
 */
function isNegated(s, at, spans = []) {
  const from = Math.max(0, at - NEG_WINDOW);
  // 2026-11-13 三轮维修（第四处，修转折连词时暴露的同类问题）：
  // **一个否定词只否定它最近的后续命中词**，不许跨过别的词。
  // 实测 bug：「不累开心」→ positive:0 negated:2 —— 「不」否定了「累」（对），
  // 又跨过「累」把后面的「开心」也否定了（错，那是另一件事）。
  // 判据：否定词与本词之间若存在**另一个命中的起点**，则这个否定词归属那个更近的词。
  const spansBetween = (p) => spans.some((sp) => sp.at > p && sp.at < at && sp.at !== at);

  const window = s.slice(from, at);
  // 从右往左找否定字：越靠近命中词的否定词越有可能是它的否定词。
  for (const n of NEGATORS) {
    let p = window.lastIndexOf(n);
    while (p !== -1) {
      if (!spansBetween(from + p)) return true;
      p = p > 0 ? window.lastIndexOf(n, p - 1) : -1;
    }
  }
  // 短语要连**命中词开头那一两个字**一起看：
  //   「别太累」里命中词是「太累」，否定短语「别太」跨在命中词边界上，
  //   只看前置窗口（「别」）匹配不到。多取 2 个字就能覆盖这种跨界情况。
  const probe = s.slice(from, Math.min(s.length, at + 2));
  for (const p of NEGATOR_PHRASES) {
    const idx = probe.indexOf(p);
    if (idx !== -1 && !spansBetween(from + idx)) return true;
  }
  return false;
}

/**
 * 统计文本里的正向/负向词命中数（词面计数，不判语义）。
 *
 * @param {string} text
 * @returns {{positive:number, negative:number, total:number, negated:number}}
 *   `negated` 是被否定词吃掉的命中数（**仅供可观测性**：让「读数为什么低」
 *   能查到原因，不参与任何计算）。
 */
export function countSentimentWords(text) {
  const s = String(text || '');
  if (!s) return { positive: 0, negative: 0, total: 0, negated: 0 };

  // 「好不好」是疑问/挽留语气，其中「好」不是愉悦信号。
  // 只排除这个词组、不删「好」本身（避免误伤「好开心」「太好了」）。
  // 用等长占位替换，保持语义位置不错位。
  //
  // 2026-11-13 三轮维修：转折/递进连词同理 —— 它们含「不」但不是否定。
  // 「不过」「不但」「不仅」「不光」在计数前先抹掉，避免被
  // isNegated() 的回看窗口误当成否定词，把后面的正向词吃掉。
  let scoped = s.replace(/好不好/g, '\u3000\u3000\u3000');
  for (const adv of ADVERSATIVE_WORDS) {
    scoped = scoped.split(adv).join('\u3000'.repeat(adv.length));
  }

  // ① 先把所有候选命中收集起来，**不直接计数**。
  //    原因：长词与短词会互相套住（「好烦」里含「烦」、「崩溃了」里含「崩溃」），
  //    直接计数会把一次情绪放大成两次。实测「好烦」原实现算 neg=2、
  //    「我特别开心，真的好开心」算 pos=3（多出来的那一次来自「开心」被
  //    「好开心」覆���计了一遍）。
  const hits = [];
  const push = (word, polarity) => {
    let i = 0;
    while ((i = scoped.indexOf(word, i)) !== -1) {
      hits.push({ word, at: i, len: word.length, polarity });
      i += word.length;
    }
  };
  for (const w of POSITIVE_WORDS) push(w, 'pos');
  for (const w of NEGATIVE_WORDS) push(w, 'neg');
  for (const w of Object.keys(SINGLE_CHAR_NEGATIVE)) push(w, 'neg');

  // ② 长词优先、同位置只留一个，消除嵌套重复。
  hits.sort((a, b) => (b.len - a.len) || (a.at - b.at));
  // 剔除被长词覆盖的重复命中后，把剩下的**真实命中**按位置排好，
  // 供 isNegated() 判断「否定词是不是越过了别的词」。
  const survivors = [];
  {
    const seenAt = new Uint8Array(scoped.length);
    for (const h of hits) {
      let free = true;
      for (let k = h.at; k < h.at + h.len; k++) if (seenAt[k]) { free = false; break; }
      if (!free) continue;
      for (let k = h.at; k < h.at + h.len; k++) seenAt[k] = 1;
      survivors.push(h);
    }
    survivors.sort((a, b) => a.at - b.at);
  }

  const taken = new Uint8Array(scoped.length);
  // ③ 同一个词在整句里**最多只计一次**（2026-11-13 三轮维修，念第 3 条）。
  //    原因：「累是累了点」「太累了太累了」「好累好累」是**强调**，
  //    不是两次独立的负向事件。原实现按出现次数各计一次 → negative=2，
  //    等于把「我说得更重」翻译成「我更难受两倍」，会让人为了被听见
  //    而越说越极端。去重后同一词只算一次，强调本身不再放大读数。
  //    ⚠️ 注意去重的粒度是**词**不是**位置**：句中同时出现「累」和
  //    「疲惫」仍算 2 次（那是两个不同的信号），只有完全相同的词才合并。
  const counted = new Set();
  let positive = 0;
  let negative = 0;
  let negated = 0;
  for (const h of hits) {
    let free = true;
    for (let k = h.at; k < h.at + h.len; k++) if (taken[k]) { free = false; break; }
    if (!free) continue;

    // ④ 单字负向词的排除网（见 SINGLE_CHAR_NEGATIVE）。
    //    只对单字生效；多字词自己就足够具体，不需要再排除。
    if (h.polarity === 'neg' && h.len === 1 && SINGLE_CHAR_NEGATIVE[h.word]) {
      const safe = SINGLE_CHAR_NEGATIVE[h.word];
      const next = scoped[h.at + 1] || '';
      const prev = h.at > 0 ? scoped[h.at - 1] : '';
      if ((safe.after || []).includes(next) || (safe.before || []).includes(prev)) {
        for (let k = h.at; k < h.at + h.len; k++) taken[k] = 1;
        continue;
      }
    }

    for (let k = h.at; k < h.at + h.len; k++) taken[k] = 1;
    // ⑤ 否定判定：被否定的命中既不进正向也不进负向，只记一笔 negated
    //    供可观测（「不累」不等于「愉悦」，按中性处理最保守）。
    if (isNegated(scoped, h.at, survivors)) { negated++; continue; }

    // ⑥ 同词去重（见上 ③）：这个词已经计过就不再计。
    if (counted.has(h.word)) continue;
    counted.add(h.word);

    // ⑦ 按词权重计数（默认 1；「还行」「凑合」这类克制的正向词是 0.5）。
    const weight = h.polarity === 'pos' ? (WORD_WEIGHTS[h.word] ?? 1) : 1;
    if (h.polarity === 'pos') positive += weight;
    else negative += weight;
  }

  // total：**不再按字符数估词数**（见文件头 ③）。
  // 取「命中总数与 1 的较大者」，使 density 恒为「该方向在命中里的占比」，
  // 不再因文本变长而被稀释 —— 修掉「说得越细情绪越弱」。
  const total = Math.max(1, positive + negative);
  return { positive, negative, total, negated };
}

/**
 * 条目倾向分（L2 心境一致用）：正向词密度 → -1~1。
 * 与 pleasure 同值域。**未标定，占位**。
 */
export function sentimentScoreOf(text) {
  const { positive, negative, total } = countSentimentWords(text);
  const net = (positive - negative) / total; // 命中为 0 时是 0，纯单向时是 ±1
  return Math.max(-1, Math.min(1, net * 4)); // 放大系数未标定，占位
}

/**
 * 心境一致分（L2）：当前 pleasure 与条目倾向分同号且幅度近则高。
 * 公式（未标定，占位）：1 - |pleasure - 条目倾向分| / 2，值域 0~1。
 */
export function moodCongruence(pleasure, itemScore) {
  const p = Math.max(-1, Math.min(1, Number(pleasure) || 0));
  const s = Math.max(-1, Math.min(1, Number(itemScore) || 0));
  return Math.max(0, Math.min(1, 1 - Math.abs(p - s) / 2));
}
