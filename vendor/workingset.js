// 会话工作集（working set）—— 让深聊不断档。
//
// 上游参考：洛灯鱼《陪伴型个人 agent 的真长期记忆系统》（小黑盒，2026-10-27，非开源）
//   §3.2「为什么加一层会话工作集」：召回只依赖当前这一句；第三轮说「那个游戏确实慢热」
//   检索不到东西，记忆就消失了。所以本会话用过、仍在场的记忆要挂在内存里，按轮次推进状态。
//
// 五态（原样照搬，一字不改语义）：
//   1 待命   —— 该记忆的证据消息仍在最近 20 条对话里 → **不注入**（原文比压缩记忆更准）
//   2 注入   —— 证据已滑出 20 条窗口 → 允许作为原子接棒
//   3 收回   —— 连续 10 轮未被提及 → 收回**不等于删除**，记录仍在库（参考 TTL）
//   4 淘汰   —— 超过 10 条容量 → 移除最久未被提及者（LRU）；**边界类常驻、上限 5**
//   5 失效   —— 渲染前重查生效状态：工作集是缓存，**已关闭的记忆不能继续注入**
//
// 为什么单独一个模块、不进 search.js：
//   · 工作集是**会话内缓存**，不是检索算法。混进 search.js 会让「打分」和「状态」绞在一起。
//   · 不改检索主分（守红线），只决定「哪些已经召回到的东西值得再摆一次」。
//   · 纯内存 + 可序列化，不写库、不联网、不调模型。
//
// 注入上限（照抄）：8 条 + 最多 2 段完整原话（同一句拆多条时，原子是压缩的，细节要原文补）。
// 拼接顺序（照抄）：身份信息 → 记忆块 → 原话参考。
//   理由：模型对 prompt 前部更敏感。先给身份，后面才是「它的记忆」；反过来同样内容会变成
//   「一份参考资料」。这条由调用方（cm-boot / handoff）负责排序，本模块只给数据。

/** 证据仍在最近多少条对话内 → 待命（不注入）。 */
import { estTokens } from './pack.js';

export const STANDBY_WINDOW = 20;
/** 连续多少轮未被提及 → 收回（不删）。 */
export const RECLAIM_AFTER_TURNS = 10;
/** 工作集容量。 */
export const MAX_ENTRIES = 10;
/** 边界类常驻上限。 */
export const MAX_BOUNDARY_RESIDENT = 5;
/** 一次最多注入几条。 */
export const INJECT_LIMIT = 8;
/** 最多附几段完整原话。 */
export const MAX_RAW_QUOTES = 2;

/** 五态常量（字符串便于序列化与排查）。 */
export const STATE = Object.freeze({
  STANDBY: 'standby',   // 待命：证据还在窗口内，不注入
  INJECT: 'inject',     // 注入：可以接棒
  RECLAIMED: 'reclaimed', // 收回：仍在库，只是不再主动注入
  EVICTED: 'evicted',   // 淘汰：移出工作集（库里那条不动）
  STALE: 'stale'        // 失效：已关闭/过期，不许再注入
});

/**
 * 工作集（纯内存对象，可 JSON 序列化）。
 * 键＝记忆 id；值＝{ id, text, boundary, evidenceTurns, lastTouchedTurn, state, injectedAt }
 */
export function createWorkingSet({ capacity = MAX_ENTRIES, boundaryCap = MAX_BOUNDARY_RESIDENT } = {}) {
  /** @type {Map<string, object>} */
  const map = new Map();
  let turn = 0;

  const api = {
    /** 推进一轮（每轮对话开始时调一次；也可在每次召回后调）。 */
    tick(n = 1) { turn += n; return turn; },

    get turn() { return turn; },
    get size() { return map.size; },
    entries() { return [...map.values()]; },

    /**
     * 记下「这一轮用到了这条」。
     * @param {string} id
     * @param {object} info { text, boundary, evidenceTurn }
     *        evidenceTurn = 该记忆的证据消息当前位于「最近第几条」（0=最新）。
     */
    touch(id, { text = '', boundary = false, evidenceTurn = 0, slot = null } = {}) {
      if (!id) return null;
      const cur = map.get(id);
      if (cur) {
        cur.lastTouchedTurn = turn;
        if (Number.isFinite(evidenceTurn)) cur.evidenceTurn = evidenceTurn;
        if (text) cur.text = text;
        if (boundary) cur.boundary = true;
        // W18：槽位随记忆一起进工作集。不带上它的话，
        // 装配阶段所有条目都会被 slotOf() 判成 other —— 实测表现就是
        // 「分组标题写着四类，底下全堆在（其它）里」，等于白做。
        if (slot) cur.slot = slot;
        return cur;
      }
      const entry = {
        id: String(id),
        text: String(text || ''),
        boundary: !!boundary,
        slot: slot || null,
        evidenceTurn: Number.isFinite(evidenceTurn) ? evidenceTurn : 0,
        lastTouchedTurn: turn,
        state: STATE.STANDBY,
        injectedAt: null
      };
      map.set(entry.id, entry);
      api._enforce();
      return entry;
    },

    /**
     * 算五态 + 返工可注入清单。
     *
     * @param {object} opts
     * @param {number} [opts.nowTurn]          当前轮（默认用内部 turn）
     * @param {Function} [opts.isLive]         (id) => boolean，渲染前重查生效状态（失效态用）
     * @returns {{ inject: object[], standby: object[], reclaimed: object[], evicted: object[], stale: object[] }}
     */
    evaluate({ nowTurn, isLive = null } = {}) {
      const t = Number.isFinite(nowTurn) ? nowTurn : turn;
      const live = typeof isLive === 'function' ? isLive : null;
      const out = { inject: [], standby: [], reclaimed: [], evicted: [], stale: [] };

      for (const e of map.values()) {
        // ⑤ 失效优先：渲染前重查——工作集是缓存，已关闭的不能继续注入。
        if (live && !live(e.id)) { e.state = STATE.STALE; out.stale.push(e); continue; }
        // ③ 收回：连续 N 轮未被提及（不删，仍在 map 里占位，但不注入）
        //    例外：**边界类不收回**——边界是长期约束（「别在他学习时弹消息」），
        //    不是会话热点；按轮次收回会把最该常驻的东西先收走。
        //    测试实测：3 条边界 + 10 轮后普通条目推进到 13 轮，边界因 lastTouchedTurn=0
        //    被判 reclaimed，注入清单里一条边界都不剩——这正是该例外要防的。
        if (!e.boundary && t - e.lastTouchedTurn >= RECLAIM_AFTER_TURNS) {
          e.state = STATE.RECLAIMED; out.reclaimed.push(e); continue;
        }
        // ① 待命：证据还在最近 WINDOW 条内 → 原文比压缩记忆准，不重复注入
        if (e.evidenceTurn < STANDBY_WINDOW) { e.state = STATE.STANDBY; out.standby.push(e); continue; }
        // ② 注入
        e.state = STATE.INJECT;
        out.inject.push(e);
      }

      // 注入上限：边界类优先常驻（最多 boundaryCap），其余按「最近被提及」优先。
      out.inject.sort((a, b) => (b.boundary ? 1 : 0) - (a.boundary ? 1 : 0) || b.lastTouchedTurn - a.lastTouchedTurn);
      const boundary = out.inject.filter((e) => e.boundary).slice(0, boundaryCap);
      const rest = out.inject.filter((e) => !e.boundary);
      const room = Math.max(0, INJECT_LIMIT - boundary.length);
      out.inject = [...boundary, ...rest.slice(0, room)];
      return out;
    },

    /** 显式移出（淘汰）。库里那条不动——这只是缓存。 */
    evict(id) {
      const e = map.get(id);
      if (!e) return false;
      e.state = STATE.EVICTED;
      map.delete(id);
      return true;
    },

    /** 序列化（跨进程/跨轮保存用；不含任何库内容之外的私料）。 */
    toJSON() { return { turn, entries: [...map.values()] }; },

    /** 反序列化。坏数据一律当空，不炸。 */
    load(obj) {
      try {
        if (!obj || typeof obj !== 'object') return api;
        const t = Number(obj.turn);
        if (Number.isFinite(t)) turn = t;
        map.clear();
        for (const e of Array.isArray(obj.entries) ? obj.entries : []) {
          if (!e || !e.id) continue;
          map.set(String(e.id), {
            id: String(e.id),
            text: String(e.text || ''),
            boundary: !!e.boundary,
            evidenceTurn: Number.isFinite(Number(e.evidenceTurn)) ? Number(e.evidenceTurn) : 0,
            lastTouchedTurn: Number.isFinite(Number(e.lastTouchedTurn)) ? Number(e.lastTouchedTurn) : 0,
            state: String(e.state || STATE.STANDBY),
            injectedAt: e.injectedAt ?? null
          });
        }
        api._enforce();
      } catch { /* 坏数据 = 空工作集，绝不拖垮开场 */ }
      return api;
    },

    /** 容量控制：先淘汰「非边界且最久未提」的；边界类受 boundaryCap 单独约束。 */
    _enforce() {
      const over = () => map.size > capacity;
      while (over()) {
        let victim = null;
        for (const e of map.values()) {
          if (e.boundary) continue;
          if (!victim || e.lastTouchedTurn < victim.lastTouchedTurn) victim = e;
        }
        if (!victim) break;           // 全是边界类，交给下面的边界上限
        victim.state = STATE.EVICTED;
        map.delete(victim.id);
      }
      // 边界类超上限：淘汰最久未提的边界条目
      const bd = [...map.values()].filter((e) => e.boundary)
        .sort((a, b) => a.lastTouchedTurn - b.lastTouchedTurn);
      while (bd.length > boundaryCap) {
        const v = bd.shift();
        v.state = STATE.EVICTED;
        map.delete(v.id);
      }
    }
  };
  return api;
}

/**
 * 组装注入块（调用方给顺序：身份 → 记忆块 → 原话参考）。
 *
 * @param {object} opts
 * @param {object[]} opts.entries    evaluate().inject 的结果
 * @param {object[]} [opts.rawQuotes] [{id, text}] 最多 MAX_RAW_QUOTES 段完整原话
 * @param {string} [opts.identity]   身份块（称呼/性格/习惯，最多 6 条常驻）
 * @param {number} [opts.maxChars]   整块字符上限（防挤掉当前问题，守注入预算）
 * @returns {{ text: string, injected: number, rawQuotes: number, truncated: boolean }}
 */
/* ------------------------------------------------------------------ *
 * 情境包槽位化（W18，2026-11-13）
 *
 * 来源：《双脑记忆系统》6.6「情境包」——4±1 槽、budget.tokens=900。
 * 原文把槽分四类：who | goal | constraint | uncertainty。
 *
 * 先说清楚我们**没照抄**的部分，免得以后有人以为是漏了：
 *  · 原文 5.3 列了六类（who/relationship/experiences/goal/commitments/changes/uncertainties），
 *    6.6 只列四类。文档自己口径不一致，我取**四槽**（少而能填满，比多而填不满好）。
 *  · 原文的顺序是「按重要性动态挤」；我们没有「重要性」这个跨槽可比量
 *    （who 的重要性和 constraint 的重要性不是同一把尺子），
 *    所以改成**每槽保底 1 条 + 槽内按权重**。这条是我拍的，写进工单口径区。
 *
 * 为什么需要槽位，而不是继续一个平坦列表：
 *   平坦列表按权重排序 = 谁的 baseWeight 高谁在场。
 *   identity/relation 是 3.0，constraint 类只有 1.3-2.5 ——
 *   结果就是**每轮都在说「他是谁」，但「他这次要我别做什么」一次都没进过**。
 *   身份是背景，约束才是当前能不能动手的依据。槽位就是在纠正这个结构性偏斜。
 * ------------------------------------------------------------------ */

/** 槽位顺序即渲染顺序：先说人，再说要干嘛，再说别踩什么，最后说哪儿还没底。 */
export const SLOT_ORDER = Object.freeze(['who', 'goal', 'constraint', 'uncertainty', 'other']);

/** 槽位中文标签与一句话说明（渲染时带上，模型才知道这一段是干嘛的）。 */
const SLOT_LABEL = Object.freeze({
  who: '是谁',
  goal: '要做什么',
  constraint: '不能做什么',
  uncertainty: '还没底的事',
  other: '其它'
});

/**
 * 从一条印象推它的槽位。
 *
 * 映射规则（可核，改动要来这里改）：
 *   · 带 category='self-note' 的由 selfNote 通道单独处理，不进这里
 *   · tag=identity/relation           → who        （他是谁、我们什么关系）
 *   · tag=agreement/preference        → goal/constraint 视有没有否定词
 *   · tag=boundary                    → constraint （边界=不能踩）
 *   · tag=event + 未完成承诺           → goal
 *   · tag=event/meme                  → other
 *   · 显式给了 `slot` 的，永远以显式为准（调用方最清楚）
 *
 * 为什么用否定词判 goal/constraint：这是**启发式**，不是语义理解。
 * 它会把「别太累」判成 constraint（对），也可能把「别客气」判成 constraint（错）。
 * 所以：只用来决定**排在哪**，不改变这条记忆的内容，也不影响权重。
 * 判错的代价是「排错位置」，不是「说错话」——这个代价可以接受。
 */
const NEG_RE = /(不|别|不要|不准|不许|不能|禁止|忌|戒|避免|千万|记得别)/;

export function slotOf(imp) {
  if (!imp) return 'other';
  if (imp.slot && SLOT_ORDER.includes(imp.slot)) return imp.slot;   // 显式优先
  const tag = String(imp.tag || '');
  const text = String(imp.text || '');
  if (tag === 'identity' || tag === 'relation') return 'who';
  if (tag === 'boundary') return 'constraint';
  if (tag === 'agreement') return NEG_RE.test(text) ? 'constraint' : 'goal';
  if (tag === 'preference') return NEG_RE.test(text) ? 'constraint' : 'other';
  if (tag === 'event' && /(要|得|答应|约|欠|该|务必)/.test(text)) return 'goal';
  if (tag === 'emotion') return 'uncertainty';
  return 'other';
}

/**
 * 按槽位装配，**每槽保底 1 条**，总 token 预算硬顶。
 *
 * 装配顺序（这个顺序决定了「预算不够时谁被砍」）：
 *   1. 每槽先放它自己权重最高的那条 —— 这是「保底」，不许被别的槽挤掉
 *   2. 剩下的预算按槽序（who→goal→constraint→uncertainty→other）轮转补
 *   为什么补的时候也用槽序而不是全局权重：全局权重就是回到原来的偏斜。
 *
 * @param {object[]} items  [{id, text, weight, slot?}]
 * @param {object} opts
 * @param {number} [opts.budgetTokens=900] 整包 token 上限
 * @param {number} [opts.perSlotMax=4]     单槽最多几条（防一槽吃满）
 * @param {boolean} [opts.requireAll=true] 是否强制每槽至少 1 条
 * @returns {{picked: object[], slots: object, tokensUsed: number, dropped: object[]}}
 */
export function assembleContext({ items = [], budgetTokens = 900, perSlotMax = 4, requireAll = true } = {}) {
  const buckets = new Map(SLOT_ORDER.map((s) => [s, []]));
  for (const it of items) {
    const s = slotOf(it);
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(it);
  }
  for (const list of buckets.values()) list.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  const lineOf = (it) => `- ${String(it.text || '').replace(/\s+/g, ' ').trim()}`;
  const costOf = (it) => estTokens(lineOf(it)) + 1;   // +1 是行尾换行

  const picked = [];
  const pickedIds = new Set();
  const dropped = [];
  let used = 0;

  const take = (it) => {
    const c = costOf(it);
    if (used + c > budgetTokens) return false;
    picked.push(it);
    pickedIds.add(String(it.id));
    used += c;
    return true;
  };

  // 第 1 轮：每槽保底 1 条（槽内最高的那条）。
  if (requireAll) {
    for (const s of SLOT_ORDER) {
      const list = buckets.get(s) || [];
      if (!list.length) continue;
      // 从高到低试，直到有一条装得下（高的太长就退而求其次，不是直接放弃这个槽）。
      let ok = false;
      for (const it of list) {
        if (take(it)) { ok = true; break; }
      }
      // 整槽一条都装不下 = 预算真的不够。不静默跳过，记进 dropped。
      if (!ok) dropped.push({ slot: s, id: list[0]?.id, reason: 'budget-exhausted' });
    }
  }

  // 第 2 轮：按槽序轮转补齐，单槽不超过 perSlotMax。
  const counts = Object.fromEntries(SLOT_ORDER.map((s) => [s, picked.filter((p) => slotOf(p) === s).length]));
  let progress = true;
  while (progress) {
    progress = false;
    for (const s of SLOT_ORDER) {
      if ((counts[s] || 0) >= perSlotMax) continue;
      const next = (buckets.get(s) || []).find((it) => !pickedIds.has(String(it.id)));
      if (!next) continue;
      if (take(next)) { counts[s] = (counts[s] || 0) + 1; progress = true; }
      else {
        // 这条装不下就不再试本槽更长的（已按权重降序，后面的只会更长或一样）。
        dropped.push({ slot: s, id: next.id, reason: 'budget-full' });
        counts[s] = perSlotMax;
      }
    }
  }

  // 没选中的全部如实回报，不静默丢材料。
  for (const it of items) {
    if (!pickedIds.has(String(it.id))) dropped.push({ slot: slotOf(it), id: it.id, reason: 'slot-full' });
  }

  const slots = {};
  for (const s of SLOT_ORDER) slots[s] = picked.filter((p) => slotOf(p) === s).length;

  return { picked, slots, tokensUsed: used, budgetTokens, dropped };
}

export function renderWorkingSet({ entries = [], rawQuotes = [], identity = '', maxChars = 1500, slots = false } = {}) {
  const parts = [];
  if (identity) parts.push(identity.trim());
  if (entries.length && slots) {
    // W18：按槽分组渲染。分组本身就在告诉模型「这几条是同一个问题」，
    // 平坦列表里「他是谁」和「他不要什么」长得一模一样，会被一视同仁地读过去。
    const grouped = SLOT_ORDER
      .map((s) => ({ s, list: entries.filter((e) => slotOf(e) === s) }))
      .filter((g) => g.list.length);
    const blocks = grouped.map((g) => [
      `（${SLOT_LABEL[g.s] || g.s}）`,
      ...g.list.map((e) => `- ${String(e.text || '').replace(/\s+/g, ' ').trim()}`)
    ].join('\n'));
    parts.push(['【会话工作集】（本会话里还在场的事，按「是谁 / 要做什么 / 不能做什么 / 还没底」分组）', ...blocks].join('\n'));
  } else if (entries.length) {
    const lines = entries.map((e, i) => `${i + 1}. ${String(e.text || '').replace(/\s+/g, ' ').trim()}`);
    parts.push(['【会话工作集】（本会话里还在场的事，已滑出近期原文窗口）', ...lines].join('\n'));
  }
  if (rawQuotes.length) {
    const q = rawQuotes.slice(0, MAX_RAW_QUOTES)
      .map((r, i) => `原话 ${i + 1}：${String(r.text || '').replace(/\s+/g, ' ').trim()}`);
    parts.push(['【原话参考】（同一件事被拆成多条时，细节以原文为准）', ...q].join('\n'));
  }
  let text = parts.join('\n\n');
  let truncated = false;
  if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
    // 超预算只截尾部（身份块在前，优先保住）
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, injected: entries.length, rawQuotes: Math.min(rawQuotes.length, MAX_RAW_QUOTES), truncated };
}
