// 工作痕迹三道筛子 —— U4，2026-11-09。
//
// 出处：总档案 §四·4 U4「工作痕迹三道筛子未做（只取状态不取内容 / 时间衰减 / 第三方隐私丢）」，
// 原始来源 一页纸.md:107。这就是那道没做的门：工作痕迹（干了什么活）照原样往印象层灌。
//
// 为什么必须分道：
//   印象层是「关于他的事」——他喜欢什么、在意什么、答应过什么。
//   工作痕迹是「他干了什么活」——今天跑了测试、改了个文件、装了个包。
//   两者混在一起，注入块会变成工作日志，模型会把「今天在做 W10」当成关于他的事实。
//
// 三道筛子（缺一不可，按顺序过）：
//   ① 只取状态、不取内容 —— 留「他在推进记忆库重构」，不留「他改了 src/index.js 第 234 行」。
//   ② 时间衰减 —— 工作痕迹是**有时效的**，三天前的进度陈述今天没有注入价值。
//      比印象层衰减快得多：印象是「他不吃香菜」这种长期事实，痕迹是「今天卡在 IDF」。
//   ③ 第三方隐私丢 —— 贴进来的报错、聊天记录、别人的原话，全部丢弃。
//      工作痕迹只需要「在做什么」，不需要「从哪抄的」。
//
// 红线：只读判定、不写库、不调模型、不联网。本模块给的是**判定 + 清洗后的文本**，
// 落不落库由调用方决定（U4 是「筛子」，不是「自动提炼」——U2 才是提炼，本期不做）。
//
// 为什么不做成自动入库：写印象要过 `validateImpression` 的人格诊断门禁，
// 工作痕迹天生容易写成「他在焦虑」「他回避了这个问题」，那是替人下判断。
// 筛子只给「可以记 / 不可以记 + 为什么」，要不要记仍由念决定。

/** 强标记：出现任意一个就足以判成工作痕迹（单标记也够，不必凑两个）。 */
const STRONG_MARKERS = [
  /卡在|卡住|卡点|阻塞/,
  /正在(?:做|改|写|推进|处理|跑|查|标定|复核|实装|对齐|收尾|接线)/,
  /(?:推进|进行)中/,
  /跑(?:了|完)(?:测试|回归|用例)/,
  /(?:提交|推送|合并|回滚)(?:了|完)/,
  /(?:通过|失败)\s*\d+\s*\/\s*\d+/,
  /(?:改|修|动)(?:了|过)?\s*(?:三|两|一|四|五|六|几|\d)\s*处/,
  /(?:下一步|待办|收尾|接线|落地|实装|标定)/
];

/** 工作痕迹的判定：这句话是不是在讲「他干了什么活」。 */
const WORK_MARKERS = [
  /(?:跑|执行|运行|装|部署|提交|推送|合并|回滚|修|改|写|删|建|拉|推)(?:了|过|完|掉)?/,
  /测试|回归|用例|通过率|覆盖率|基线|构建|编译|打包|发布/,
  /commit|push|pull|merge|rebase|branch|diff|patch|PR\b/i,
  /版本|发版|升级|降级|迁移|备份|恢复/,
  /排查|定位|复现|根因|bug|缺陷|报错|异常|超时|失败|崩溃/i,
  // 进度陈述：这一类最常被漏判，但它们恰恰是最典型的「工作痕迹」
  /正在|在(?:做|改|写|推进|处理|搞|弄|调)/,
  /推进|推进中|进行中|收尾|接线|落地|实装|标定|对齐|复核/,
  /卡在|卡住|阻塞|待办|下一步|接下来|准备(?:做|改|上)/
];

/** 第三方内容标记：命中即丢（第三道筛子）。 */
const THIRD_PARTY_MARKERS = [
  /^(?:```|~~~)/m,                        // 代码块
  /^\s*(?:\$|>|PS>|C:\\|\/root\/|\/home\/)/m, // shell 提示符/绝对路径开头
  /(?:他说|她说|他们说|对方说|同事说|网友说)[:：]/,  // 转述别人
  /(?:https?:\/\/|www\.)\S+/,              // URL
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,  // 邮箱
  /(?:\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/,      // IP
  /(?:Bearer\s+[A-Za-z0-9._-]{16,}|sk-[A-Za-z0-9]{16,})/i, // token
  /(?:错误|异常|报错|Exception|Error|Traceback)[:：]?\s*\S{20,}/i // 长报错正文
];

/** 能从「内容」里提出来的状态词：只留这些，其余（文件路径、代码、数字细节）丢。 */
const STATE_PATTERNS = [
  // 「正在/在 + 动作词」：必须紧跟动作动词，否则「还在这儿」「在那天」会被误提成状态
  /(?:正在|在)(?:做|改|写|推进|处理|搞|弄|调|跑|查|看|接|标定|复核|实装|对齐|收尾)([^，。；\n]{0,22})/,
  /(?:推进|处理|做|改|写|标定|复核|实装|对齐|落地|收尾|接线)([^，。；\n]{2,20})/,
  /([^，。；\n]{2,20}?)(?:做完了|跑通了|通过了|修好了|装好了|落地了|完成了|收尾了)/,
  /卡(?:在|住)([^，。；\n]{2,20})/,                        // 卡在 X
  /(?:下一步|接下来|准备|打算)(?:做|改|上|推进)?([^，。；\n]{2,20})/
];

/** 结果型短句：「回归通过」「测试全绿」这类，直接成状态。 */
const RESULT_KINDS = '回归|测试|用例|构建|打包|发布|编译';
const RESULT_STATES = '通过|全绿|失败|超时|挂了|跑通';

/**
 * 结果型判定：同时出现「什么类型的活」+「什么结果」，就压成「回归通过」四字状态。
 * 比正则顺序匹配稳：不管中间夹着多少数字/标点都能认。
 */
function resultState(s) {
  const k = s.match(new RegExp(`(${RESULT_KINDS})`));
  if (!k) return null;
  const r = s.match(new RegExp(`(${RESULT_STATES})`));
  if (!r) return null;
  return `${k[1]}${r[1]}`;
}

/** 痕迹的半衰期（天）。比印象层快：痕迹讲的是「现在在干什么」。 */
export const TRACE_HALF_LIFE_DAYS = 2;

/** 痕迹的存活上限（天）。超过这个天数，痕迹不再有注入价值，判失效。 */
export const TRACE_MAX_AGE_DAYS = 7;

/**
 * 这句话是不是工作痕迹。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeWorkTrace(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 强标记一个就够（「卡在 X」本身就说明在干活，不用再凑一个动词）
  if (STRONG_MARKERS.some((re) => re.test(t))) return true;
  // 结果型短句（「回归通过」「测试全绿」「编译失败」）：stateOnly 能用
  // resultState 把它们压成状态，判定层却漏掉的话，整条会在 sieve 第一步被丢——
  // 模块内部不一致。这里补上：必须同时有「活的类型词 + 结果词」才算，
  // 「他喜欢香菜」「今天有点累」这类生活句不含这两类词，不受影响。
  if (resultState(t)) return true;
  // 弱标记要命中两个才算：单个太宽（"改"这个字日常对话里到处都是）
  const hits = WORK_MARKERS.filter((re) => re.test(t)).length;
  return hits >= 2 || (hits >= 1 && t.length > 60);
}

/**
 * 第二道：时间衰减。工作痕迹按天掉，超过 TRACE_MAX_AGE_DAYS 直接判失效。
 *
 * 为什么不复用 impression 的 weightOf：那套是「长期事实慢慢淡」，这里是「短期状态快速过期」。
 * 复用会让三天前的「今天卡在 IDF」跟「他不吃香菜」一样耐用——那正是现在的问题。
 *
 * @param {number} t     痕迹时间戳（毫秒）
 * @param {number} [now]
 * @returns {{ alive: boolean, weight: number, ageDays: number, reason: string }}
 */
export function traceDecay(t, now = Date.now()) {
  const at = Number(t) || 0;
  const ageDays = Math.max(0, (now - at) / 86400000);
  if (ageDays > TRACE_MAX_AGE_DAYS) {
    return { alive: false, weight: 0, ageDays: +ageDays.toFixed(1), reason: `超过 ${TRACE_MAX_AGE_DAYS} 天，痕迹已过期` };
  }
  // 指数衰减：每 TRACE_HALF_LIFE_DAYS 天权重减半
  const weight = Math.pow(0.5, ageDays / TRACE_HALF_LIFE_DAYS);
  return { alive: true, weight: +weight.toFixed(3), ageDays: +ageDays.toFixed(1), reason: '' };
}

/**
 * 第三道：第三方隐私。命中即整条丢弃，不做「部分脱敏」——
 * 脱敏后剩下的半句话反而更容易被当成事实记住。
 *
 * @param {string} text
 * @returns {{ clean: boolean, leaked: string[] }}
 */
export function dropThirdParty(text) {
  const t = String(text || '');
  const leaked = [];
  for (const re of THIRD_PARTY_MARKERS) {
    const m = t.match(re);
    if (m) leaked.push(m[0].slice(0, 40));
  }
  return { clean: leaked.length === 0, leaked };
}

/**
 * 第一道：只取状态、不取内容。把「他改了 src/index.js 第 234 行的 budget 默认值」
 * 压成「在调整 pack 预算」这类状态描述。
 *
 * 保守策略：**提不出状态就返回空**，而不是把原句留下来。
 * 理由：这道筛子的存在意义就是「不取内容」，原句留着等于没筛。
 *
 * @param {string} text
 * @returns {{ state: string, kept: boolean, reason: string }}
 */
export function stateOnly(text) {
  const t = String(text || '').trim();
  if (!t) return { state: '', kept: false, reason: '空文本' };

  // 先剥掉明显的「内容」：路径、代码标识符、长数字串、括号里的细节
  let s = t
    .replace(/`[^`]*`/g, '')
    .replace(/[\w./\\-]{2,}\.(?:js|mjs|json|md|py|ts|tsx|css|html|sh|yml|yaml|txt)\b/gi, '')
    .replace(/[A-Za-z]:[\\/][^\s，。；]+/g, '')
    .replace(/\b\d{3,}\b/g, '')
    .replace(/[（(][^）)]{8,}[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!s) return { state: '', kept: false, reason: '剥掉内容后为空' };

  // 结果型短句优先：它们本身就是完整状态，不用再从里面抽子串
  const rs = resultState(s);
  if (rs) return { state: rs, kept: true, reason: '' };

  // 从残留里提状态短语
  for (const re of STATE_PATTERNS) {
    const m = s.match(re);
    if (m) {
      // 组合整个匹配（前缀动作词 + 捕获），比只取 m[1] 更完整：
      // 只取 m[1] 会把「在推进 pack 预算标定」压成「pack 预算标定」，丢了「在推进」这个关键状态。
      const st = m[0].trim().replace(/[，。；、].*$/, '').trim();
      if (st.length >= 2 && st.length <= 30) {
        return { state: st, kept: true, reason: '' };
      }
    }
  }

  // 提不出明确状态：只有很短（≤20 字）且不含数字细节的，才当成状态本身留下
  if (s.length <= 20 && !/\d{3,}/.test(s)) {
    return { state: s, kept: true, reason: '短句直当状态' };
  }
  return { state: '', kept: false, reason: '提不出状态（这句主要在讲内容）' };
}

/**
 * 三道筛子串起来跑。这是唯一对外入口。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.t]    痕迹时间戳（第二道筛子用；不给就按现在算，即「刚发生」）
 * @param {number} [opts.now]
 * @returns {{
 *   keep: boolean,
 *   state: string,
 *   weight: number,
 *   trace: boolean,
 *   stages: {workTrace:boolean, state:{...}, decay:{...}, thirdParty:{...}},
 *   reason: string
 * }}
 */
export function sieveWorkTrace(text, { t, now = Date.now() } = {}) {
  const stages = {};

  // 先判是不是工作痕迹。不是的话这整道门不管它（普通印象不走这里）。
  const trace = looksLikeWorkTrace(text);
  stages.workTrace = trace;
  if (!trace) {
    return { keep: false, state: '', weight: 0, trace: false, stages, reason: '不是工作痕迹，不走这道门' };
  }

  // ③ 第三方隐私（先做：命中就整条丢，省得后面白算）
  const tp = dropThirdParty(text);
  stages.thirdParty = tp;
  if (!tp.clean) {
    return { keep: false, state: '', weight: 0, trace: true, stages, reason: `含第三方内容（${tp.leaked.join(' / ')}），整条丢弃` };
  }

  // ① 只取状态不取内容
  const st = stateOnly(text);
  stages.state = st;
  if (!st.kept) {
    return { keep: false, state: '', weight: 0, trace: true, stages, reason: `只取状态失败：${st.reason}` };
  }

  // ② 时间衰减
  const dc = traceDecay(Number(t) || now, now);
  stages.decay = dc;
  if (!dc.alive) {
    return { keep: false, state: st.state, weight: 0, trace: true, stages, reason: dc.reason };
  }

  return { keep: true, state: st.state, weight: dc.weight, trace: true, stages, reason: '' };
}
