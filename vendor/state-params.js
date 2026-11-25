// state_params —— 让「状态」直接改变运行时参数，而不是只在 prompt 里说一句。W17，2026-11-13。
//
// 来源：《双脑记忆系统》2.7.1 / 2.7.2。原文的核心区分：
//   · state_view   进 prompt —— 模型**可以**忽略它
//   · state_params 进 runtime —— 模型**没有机会**忽略它
//
// 为什么这个区分重要（原文口径，我认）：
//   我们一直把「你现在压力大、该慎重些」写进提示词，然后祈祷模型照做。
//   但提示词是**建议**，不是**约束**。真正的约束是「检索只给 4 条」
//   「每句都要验」「不确定就弃权」——这些是代码决定的，模型改不了。
//
// 三条硬规则（原文，逐条落实，写在代码注释里免得以后被"优化"掉）：
//   1. **参数只由状态推导，不得由模型写。** 本模块不导出任何写入函数，
//      params 是纯函数的返回值。没有任何入口能让模型把 top_k 调成 20。
//   2. **越界即拒绝，不静默截断。** clamp 后如果值和原值不同就抛错。
//      原文的意思是：静默截断会把「状态算错了」伪装成「一切正常」，
//      而前者是 bug，后者是没 bug —— 这两件事绝不能长得一样。
//   3. **必须版本化 + 落日志。** 落 params-ledger.jsonl，能回答
//      「这次为什么 top_k=6」。没有这一条，以上两条都没法核。
//
// 原文的判据：**"任何『改了 prompt 就让参数变了』的实现都应判失败"**。
// 测试里那条 `只改 prompt 不改 state，params 必须逐位不变` 就是照这句写的。
//
// 已知边界（诚实标，不装）：
//   PDF 给的映射公式自己标了「示例，不是标定值」，我照抄了形式，
//   六个状态维里只有三个能被本库真实测量，另三个是**默认常量 + 标 unmeasured**。
//   这不是实现完整，这是实现了能实现的部分。
//
// 2026-11-19（A-01 · A4/W17 认默认口径）：另三个维不是「暂时没测」，是**永不测量**。
//   判据不是「现在没数据」，是「本库结构上就拿不到」：没有目标模型 → goal_pressure；
//   只有情绪四轴、没有关系张力的独立测量 → relationship_strain；
//   没有承载力测量手段、也不该替她决定 → coping_capacity。
//   口径全文见 doc-06-context/W17-三个状态维永不测量-口径说明-20261119.md。
//   公式、默认值、用例一律不动 —— 这次只改口径。

import fs from 'node:fs';
import path from 'node:path';
import { frozenNow } from './freeze-guard.mjs';

export const STATE_PARAMS_VERSION = 'state-params/v1';

/**
 * 六个状态维。取值按原文口径都在 [0,1]。
 *
 * 我们**能测**的三个：
 *   uncertainty            —— 检索 top1 与 top2 的分差反比（分差小 = 拿不准）
 *   unresolved_commitments —— 未兑现的 agreement 条数（归一化）
 *   resource_load          —— 上下文占用比
 *
 * 我们**永远测不了**的三个（默认值 + 恒标 unmeasured，不是「暂时没测」）：
 *   goal_pressure          —— 需要「当前目标离 Deadline 多远」，本库不知道目标
 *   relationship_strain    —— 需要关系张力测量，本库只有情绪四轴，不是同一个东西
 *   coping_capacity        —— 需要「她此刻能扛多少」，无法测
 *
 * 为什么不拿情绪四轴凑：情绪是「她此刻什么感觉」，coping 是「她能扛多少事」，
 * 两者相关但不等价。拿 pleasure 硬当 coping 会让「她心情好」变成「她可以承受更多压力」，
 * 那是我们**替她决定**她能扛多少 —— 越界了。宁可标 unmeasured。
 */
export const STATE_DEFAULTS = {
  goal_pressure: 0.3,
  relationship_strain: 0.0,
  resource_load: 0.5,
  uncertainty: 0.5,
  unresolved_commitments: 0.0,
  coping_capacity: 0.7
};

/**
 * 这三个在本库里**没有测量手段**（不是「暂时没有」）——默认值只是占位。
 * 理由见文件头 2026-11-19 那段；口径全文见 doc-06-context/W17-三个状态维永不测量-口径说明-20261119.md。
 */
export const UNMEASURED_KEYS = ['goal_pressure', 'relationship_strain', 'coping_capacity'];

/** 参数取值范围。越界即抛，见硬规则 2。 */
export const PARAM_BOUNDS = {
  top_k: [4, 20],
  verify_ratio: [0, 1],
  abstain_thresh: [0.1, 0.8]
};

/**
 * 取界并检查。**导出是为了能测**——不是给业务代码随便调。
 *
 * 一句必须写下来的实话（2026-11-13 实测）：
 * 在 [0,1] 的合法状态域内，上面三条公式**推不出越界值**——
 *   top_k 的理论区间是 [4, 16]，verify_ratio 是 [0.2, 1.0]，abstain_thresh 是 [0.2, 0.5]，
 * 全都在 PARAM_BOUNDS 里。所以这个 clamp **在正常路径上永不触发**，
 * 它是防御性代码，不是常态分支。
 *
 * 那还要它做什么？两件事：
 *   ① 状态值本身越界（比如有人传了 1.5）→ 在 normalizeState 就抛，不进这里；
 *   ② 将来有人改了公式系数而忘了改 PARAM_BOUNDS → 这里会立刻炸，
 *      而不是静默把 top_k 截成 20 让一切「看起来正常」。
 *
 * 原文硬规则 2 要防的正是第 ②种情况。诚实地说，它不是「现在有用的护栏」，
 * 是「以后改公式时的报警器」。
 */
export const clampParam = (name, raw) => {
  const [lo, hi] = PARAM_BOUNDS[name];
  if (!Number.isFinite(raw)) {
    throw new Error(`state_params: ${name} 算出非有限数（${raw}）。状态值必须先校验再传进来。`);
  }
  const c = Math.min(hi, Math.max(lo, raw));
  // 硬规则 2：截断即异常。
  // 为什么不能只在 console 里 warn 一下：warn 会被日志淹没，
  // 而「top_k 本该是 25 却被截成 20」意味着状态公式已经跑飞了，
  // 那必须**让调用方看见**，不能让它悄悄降级成一条正常查询。
  if (Math.abs(c - raw) > 1e-12) {
    throw new Error(
      `state_params: ${name}=${raw} 超出 [${lo}, ${hi}]，拒绝静默截断。`
      + '（《双脑记忆系统》2.7.2 硬规则：越界即拒绝。要么修状态输入，要么改 PARAM_BOUNDS 并写明理由。）'
    );
  }
  return c;
};

/** 校验输入状态：六个键都必须给，值必须在 [0,1]。 */
export function normalizeState(state = {}) {
  const out = {};
  for (const k of Object.keys(STATE_DEFAULTS)) {
    const v = state[k];
    if (v === undefined) {
      out[k] = STATE_DEFAULTS[k];
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new Error(`state_params: 状态维 ${k} 必须在 [0,1]，实得 ${v}`);
    }
    out[k] = n;
  }
  return out;
}

/**
 * impact_gap = 前四者之和 − coping_capacity（原文口径）。
 * 直觉：要做的事越多、越不确定、关系越紧，且她能扛的越少 → 缺口越大。
 */
export function impactGapOf(state) {
  const s = normalizeState(state);
  return (s.goal_pressure + s.relationship_strain + s.resource_load + s.uncertainty) - s.coping_capacity;
}

/**
 * 核心：状态 → 参数。**纯函数**，不读环境、不读文件、不接受模型输入。
 *
 * 公式照《双脑记忆系统》2.7.2（原文标「示例」，我照搬形式并在下面注明哪几个是硬推的）：
 *   top_k          = clamp(12 - 8*goal_pressure + 4*uncertainty, 4, 20)
 *   verify_ratio   = clamp(0.2 + 0.6*uncertainty + 0.2*relationship_strain, 0, 1)
 *   abstain_thresh = clamp(0.5 - 0.3*uncertainty, 0.1, 0.8)
 *
 * 这三条我只实现了原文给的三条. 另外四条（goal_weight / fast_path / depth /
 * encode_thresh）**没做**，理由写进了工单的「未做的」：
 * 它们要么需要我们还没有的概念（fast_path 需要一条真正的快慢双通道），
 * 要么需要标定数据（encode_thresh 是编码门，改错了会静默丢记忆）。
 * 少三参数但能用、可核，好过七参数全靠猜。
 *
 * @param {object} state 六个状态维
 * @returns {{params: object, state: object, impactGap: number, version: string, unmeasured: string[], why: object}}
 */
export function paramsFromState(state = {}) {
  const s = normalizeState(state);
  const impactGap = impactGapOf(s);

  // top_k 是**条数**，必须是整数。原文公式给的是连续值（12-8*g+4*u），
  // 直接当条数用会出现「取前 11.6 条」这种没法执行的东西 —— 四舍五入到整数。
  const top_k = clampParam('top_k', Math.round(12 - 8 * s.goal_pressure + 4 * s.uncertainty));
  const verify_ratio = clampParam('verify_ratio', 0.2 + 0.6 * s.uncertainty + 0.2 * s.relationship_strain);
  const abstain_thresh = clampParam('abstain_thresh', 0.5 - 0.3 * s.uncertainty);

  return {
    version: STATE_PARAMS_VERSION,
    state: s,
    impactGap,
    params: { top_k, verify_ratio, abstain_thresh },
    unmeasured: UNMEASURED_KEYS.filter((k) => s[k] === STATE_DEFAULTS[k]),
    // 「这次为什么 top_k=6」——逐项记来源，供 ledger 落盘与人工复核。
    why: {
      top_k: `round(12 - 8*goal_pressure(${s.goal_pressure}) + 4*uncertainty(${s.uncertainty})) = ${top_k}（原值 ${(12 - 8 * s.goal_pressure + 4 * s.uncertainty).toFixed(4)}）`,
      verify_ratio: `0.2 + 0.6*uncertainty(${s.uncertainty}) + 0.2*relationship_strain(${s.relationship_strain}) = ${(0.2 + 0.6 * s.uncertainty + 0.2 * s.relationship_strain).toFixed(4)}`,
      abstain_thresh: `0.5 - 0.3*uncertainty(${s.uncertainty}) = ${(0.5 - 0.3 * s.uncertainty).toFixed(4)}`
    }
  };
}

/**
 * 从一次检索结果里推 uncertainty（本库唯一能自测的状态维）。
 *
 * 口径：top1 与 top2 的**分差**越小越不确定。
 * 只给一条结果时：没有第二条可比 → 按中性 0.5（不能当成「非常确定」——
 * 只有一条可能只是因为库里就一条，那是「没得选」，不是「很笃定」）。
 * 一条都没有 → 1.0（完全不确定）。
 *
 * @param {Array<{score?:number, sim?:number}>} hits
 * @returns {number} 0~1
 */
export function uncertaintyFromHits(hits) {
  const list = (Array.isArray(hits) ? hits : []).filter(Boolean);
  if (!list.length) return 1;
  if (list.length < 2) return 0.5;
  const score = (h) => Number(h.score ?? h.sim ?? 0) || 0;
  const gap = Math.abs(score(list[0]) - score(list[1]));
  // 分差 ≥0.3 视为完全分得开（这个 0.3 是**经验值，未标定**，标在这里免得被当成定律）。
  return Math.max(0, Math.min(1, 1 - gap / 0.3));
}

/**
 * 从「未兑现的 agreement 条数」推 unresolved_commitments。
 * 归一化到 5 条封顶：超过 5 条未兑现承诺，这个维度就已经饱和了，
 * 再加也只是「很多」，不影响先验判断。
 */
export function unresolvedFromCount(n) {
  const c = Math.max(0, Number(n) || 0);
  return Math.min(1, c / 5);
}

/**
 * 落 params 账本（硬规则 3：必须版本化 + 落日志）。
 *
 * 「这次为什么 top_k=6」必须能回答。所以每条账本都带：
 *   · 输入（六个状态维）+ 输出（三个参数）
 *   · `why`（逐项算式，人眼看就能复算）
 *   · `version`（公式改过之后，老账本能被识别成老口径）
 *   · `query`（可选，便于按查询回查）
 *
 * 落盘位置：`<dir>/params-ledger.jsonl`，append-only。
 * 为什么不放进 raw/events：那不是「事件」，是**运行时决策的审计记录**，
 * 混进去会把检索语料污染成「她自己的参数日志」。
 *
 * @param {string} dir           库目录（.companion-memory）
 * @param {object} computed      `paramsFromState()` 的返回值
 * @param {object} [extra]       追加字段（query / hits 数 / 调用点）
 * @returns {string|null} 写下的那一行（便于测试断言），失败返回 null
 */
export function appendParamsLedger(dir, computed, extra = {}) {
  if (!dir || !computed?.params) return null;
  // 冻结闸（N-01 接线）：账本也是库里的字节。返回 null 与「写失败」同形，
  // 调用方本就按「账本没写成」处理，不会拦主流程。
  if (frozenNow(dir, '写参数账本')) return null;
  const line = JSON.stringify({
    t: Date.now(),
    version: computed.version || STATE_PARAMS_VERSION,
    state: computed.state,
    params: computed.params,
    impactGap: computed.impactGap,
    unmeasured: computed.unmeasured,
    why: computed.why,
    ...extra
  });
  try {
    const file = path.join(dir, 'params-ledger.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return line;
  } catch {
    // 账本写不进去不能拦主流程：那会把「审计」变成「单点故障」。
    // 但也不能假装成功——返回 null，调用方可记一笔降级。
    return null;
  }
}
