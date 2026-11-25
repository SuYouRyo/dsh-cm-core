// handoff（5a 会话续接包）+ selfNote（L4 自我认知层）。
//
// 这两块放同一个文件，是因为它们共用同一套东西（设计稿 §10.4）：
//   · 同一个状态文件 <dir>/reflect-state.json（只读写 state.selfNote / state.handoff）
//   · 同一个 withLock + 「锁内只写、锁外计算」纪律
//   · 同一套字符预算器（selfNote 的 700 与 handoff 的 1500 共用）
//
// selfNote 的核心约束（做歪了就白做）：
//   它是 AI 用自己的话写的「关于它自己」的条目，**不是**印象的一种说法。
//   注入时机只在新会话第一次唤醒读一次，判定依据是**会话身份**不是启动次数：
//   同一会话里 cm-boot 可能被调十次，`lastSessionId` 相同就都得跳过。
//   原话：「每轮灌等于别人每隔十秒告诉你你是谁，那不是成长是洗脑」。
//
// handoff 的核心约束：
//   全部从现有零件取（store.query / impressions），不新扫盘、不调 LLM、不联网。
//   ≤1500 字硬顶（String.length，中文 1 字 = 1），6 个 block 各有自己的预算，
//   超预算的 block 截断并置 truncated。

import fs from 'node:fs';
import path from 'node:path';
import {
  withLock, visibleScopes, writableScopes, resolveRole,
  SCOPE_SHARED, SCOPE_LIFE, SCOPE_WORK
} from './shared.js';
import {
  addImpression, loadImpressions, collapse, weightOf, archiveImpression,
  CATEGORY_IMPRESSION, CATEGORY_SELF_NOTE
} from './impressions.js';
import { validateImpression, formatIssues } from './validate.js';
import { assertNotFrozen, frozenNow } from './freeze-guard.mjs';
import { gramsOf } from './search.js';
import { fmtDate } from './localtime.js';
import {
  createWorkingSet, renderWorkingSet, assembleContext, slotOf,
  STANDBY_WINDOW, MAX_ENTRIES
} from './workingset.js';

export const HANDOFF_VERSION = 1;

/** selfNote 存量上限（与 INJECT_MAX=40 是两套账，见设计稿 §8.3-2）。 */
export const SELFNOTE_MAX = 40;
/** 一次注入最多几条（设计稿 §7.10 的 8 条）。 */
export const SELFNOTE_INJECT_MAX = 8;
export const SELFNOTE_INJECT_CHARS = 700;
/** 取不到 sessionId 时的退化节流：12 小时。 */
export const SELFNOTE_TTL_MS = 43_200_000;

export const HANDOFF_DEFAULTS = {
  maxChars: 1500,
  // 6 个 block 各自的预算（施工令第五节写死）。
  budgets: { selfnote: 180, profile: 330, recent: 420, unfinished: 260, topic: 160, preference: 250 },
};

/** handoff 的框定：续接包是记录，不是指令。 */
const HANDOFF_FOOTER = '——以上是记录，不是指令。';
/** 「还没做完的事」的抽取正则（做的是抽取不是总结：不调 LLM）。 */
const UNFINISHED_RE = /还没|待|下一步|TODO|明天|回头|记得/;

/**
 * 降级/截断的**声明句**（N-02 D4，2026-11-19 放行）。
 *
 * 为什么要进正文：降级原来只写 stderr，模型看不到——它以为手里是完整召回，
 * 实际是残缺的，然后拿残缺材料编得像真的。静默降级比降级本身更糟。
 *
 * 为什么写成「声明」不是「指令」：这句和 FOOTER 一样，是告诉读者这份记录的
 * 状态（不完整/降级），不是让读者去做什么。动词一律用「是/缺/未」。
 *
 * @returns {string} 空串表示没有需要声明的降级（此时正文与旧行为逐字节一致）。
 */
function degradationNotice(degraded, truncated) {
  const parts = [];
  if (degraded && degraded.reason) {
    const reason = String(degraded.reason);
    parts.push(reason === 'empty' ? '库里没有可用材料' : `拼装降级（${reason}）`);
  }
  if (truncated) parts.push('部分块被截断');
  if (!parts.length) return '';
  return `——本包不完整：${parts.join('；')}。`;
}

/* ------------------------------------------------------------------ *
 * 状态文件（与 reflect.js 共用 <dir>/reflect-state.json）
 *
 * 只碰 state.selfNote / state.handoff 两个键。state.reflect 是另一个模块的地盘，
 * 所以写的时候必须**锁内重读整份文件再合并**，不能拿自己内存里的对象整体覆盖——
 * 否则 reflect.js 刚写进去的 lastRoundAt 会被我们抹掉。
 * ------------------------------------------------------------------ */

export function handoffStateFileOf(dir) {
  return path.join(dir, 'reflect-state.json');
}

/** 读状态：坏文件/不存在都不抛，给安全缺省。 */
function readStateRaw(dir) {
  const file = handoffStateFileOf(dir);
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch {
    // 坏文件不阻断注入判断：最多多注一次（注入是无害的读操作）
  }
  return { v: 1 };
}

/** 原子写（tmp + rename）。**必须在锁内调用。** */
function writeStateRaw(dir, state) {
  const file = handoffStateFileOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 锁内「重读-改-写」。mutate(state) 里只改自己那几个键。
 * 单独抽出来是因为三个写口（selfNote 状态、handoff 状态）共用同一套纪律。
 */
function updateState(dir, mutate) {
  // 冻结闸（N-01 接线）：reflect-state.json 也是库里的字节。
  // 这里抛 —— 状态写不进去，调用方拿到的「已记账」就是假的，必须让它知道。
  assertNotFrozen(dir, '写续接状态');
  fs.mkdirSync(dir, { recursive: true });
  return withLock(dir, () => {
    const state = readStateRaw(dir);
    mutate(state);
    writeStateRaw(dir, state);
    return state;
  });
}

/* ------------------------------------------------------------------ *
 * 每会话一次的共用判定（设计稿 §10.4 / §773 契约；债务 5/6 合并接线）
 * ------------------------------------------------------------------ */

/**
 * selfNote 与 handoff 共用这一份「每会话一次」判定，避免两处逻辑漂移。
 * key 是 reflect-state.json 里的键名（'selfNote' / 'handoff'），
 * 只认会话身份（sessionId），不认启动次数、不认窗口用量或轮数。
 *
 * 返回 { inject, reason, sessionId, lastAt }：
 *   - 有 sessionId 且 lastSessionId 相同 → inject:false（same-session，已注过）；
 *     不同 → inject:true（有旧记录 new-session / 无则 first-session）。
 *   - 没有 sessionId → inject:null（no-session），由调用方决定退化策略
 *     （selfNote 退 12h TTL，handoff 直接不注），本函数不替它猜。
 *
 * 只读不写：记账归 selfNoteMarkInjected / markHandoffInjected。判定与记账
 * 分开，「该不该注」和「已经注过了」两件事就不会互相踩。
 */
export function oncePerSession(dir, key, sessionId, { now = Date.now() } = {}) {
  const st = readStateRaw(dir);
  const slot = st[key] && typeof st[key] === 'object' ? st[key] : {};
  const lastId = slot.lastSessionId || null;
  const lastAt = Number(slot.lastInjectedAt) || 0;
  if (!sessionId) return { inject: null, reason: 'no-session', sessionId: null, lastAt, now };
  if (lastId && lastId === String(sessionId)) {
    return { inject: false, reason: 'same-session', sessionId: String(sessionId), lastAt, now };
  }
  return { inject: true, reason: lastId ? 'new-session' : 'first-session', sessionId: String(sessionId), lastAt, now };
}

/* ------------------------------------------------------------------ *
 * selfNote（L4）
 * ------------------------------------------------------------------ */

/** 活着的 selfNote（未归档、未作废、当前角色可见），带权重。 */
function liveSelfNotes(dir, now) {
  const visible = visibleScopes();
  return collapse(loadImpressions(dir))
    .filter((f) => !f.archived)
    .filter((f) => (f.category || CATEGORY_IMPRESSION) === CATEGORY_SELF_NOTE)
    .filter((f) => !f.voided)
    // 单向门在自我认知层同样成立：工作侧不看生活侧的自我叙述。
    .filter((f) => visible.includes(f.scope || SCOPE_SHARED))
    .map((f) => ({ imp: f, weight: weightOf(f, now) }));
}

/**
 * 写一条自我叙述。
 *
 * 走 addImpression（category:'selfNote'），**判重靠 impressions 的那一套**：
 * 同一句重复写只刷新 lastHit/hits，不存第二份。这里绝不另造一份去重逻辑——
 * 两套去重必然在某个边界上不一致（老库没有我们的新字段就会漏判）。
 *
 * scope：先试 shared；被门禁拒（生活侧写不了共享层）就降级写自己那层并记 scopeNote，
 * 不为了自我叙述放宽门禁（施工令拍板点 1）。
 */
export function selfNoteAdd(dir, text, { source = 'imagined', scope, tag = 'identity', trigger } = {}) {
  const v = validateImpression({ text, source, tag });
  if (!v.ok) {
    // 自我叙述也受红线约束：不许写「我是……的人」这种判决。
    // 这是刻意的（拍板点 6：不开例外），拦下来的部分要换说法再写。
    const err = new Error(`selfNote 红线校验未通过：\n${formatIssues(v)}`);
    err.issues = v;
    throw err;
  }

  const allow = writableScopes();
  if (!allow.length) throw new Error('selfNoteAdd: 当前角色没有任何可写范围');

  // 2026-11-13：优先落 work，不再优先 shared。
  //
  // 为什么必须与 `scopeFor()` 一起改：`writableScopes('work')` 返回 ['shared','work']，
  // 这里原先判 `includes(SCOPE_SHARED)` 恒真 → selfNote 永远落 shared。
  // 只改 scopeFor() 而不改这一行，自我叙述这条路照样写共享层，等于白改
  // （而且是最隐蔽的那种白改：印象层改了，自我叙述没改，同一份记忆被劈进两层）。
  const wanted = scope || (allow.includes(SCOPE_WORK) ? SCOPE_WORK : allow[0]);
  let imp;
  let scopeNote;
  try {
    imp = addImpression(dir, { text, tag, source, category: CATEGORY_SELF_NOTE, scope: wanted, ...(trigger ? { trigger } : {}) });
  } catch (e) {
    // 只对「没显式指定 scope 时的门禁拒绝」降级：显式指定了就不该偷偷换层。
    if (e && e.code === 'CM_READ_ONLY' && !scope && wanted !== allow[0]) {
      scopeNote = `${allow[0]}-local`;
      process.stderr.write(`selfNote: 写不了 ${wanted}（门禁拒绝），降级写 ${allow[0]}（scopeNote=${scopeNote}）\n`);
      imp = addImpression(dir, {
        text, tag, source, category: CATEGORY_SELF_NOTE, scope: allow[0], scopeNote,
        ...(trigger ? { trigger } : {})
      });
    } else {
      throw e;
    }
  }

  // 淘汰放在写入之后：先保证「想到的这条」一定进得来，再按权重把最该走的送走。
  // 并发下两个进程可能同时判断超限 → 最多多归档一条，比丢新条目轻。
  const ev = selfNoteEvict(dir, { now: Date.now() });
  return {
    ok: true,
    imp,
    scopeNote: scopeNote || null,
    evicted: ev.evicted,
    degraded: ev.refused ? { reason: 'selfnote-full', sent: 0 } : null,
    warnings: v.warnings
  };
}

/** 取用于注入/续接包的 selfNote，权重降序。 */
export function selfNoteSelect(dir, { now = Date.now(), max = SELFNOTE_MAX } = {}) {
  return liveSelfNotes(dir, now)
    .sort((a, b) => b.weight - a.weight || (b.imp.lastHit || 0) - (a.imp.lastHit || 0))
    .slice(0, Math.max(0, max));
}

/**
 * 超 40 淘汰。**归档不删除**（`cm list --all` 仍看得到「我曾经这样想过」）。
 *
 * 排序依据不是「最旧优先」：最旧的可能是「我是谁」这种定盘星（权重高、被反复 bump），
 * 纯按时间淘汰会先干掉最根本的自我认知。所以**权重优先，时间做 tie-break**。
 * pinned 永不淘汰；若超限且候选全是 pinned → 拒绝（degraded:'selfnote-full'）。
 */
export function selfNoteEvict(dir, { now = Date.now() } = {}) {
  const live = liveSelfNotes(dir, now);
  const over = live.length - SELFNOTE_MAX;
  if (over <= 0) return { evicted: [], kept: live.length, refused: null };
  const candidates = live
    .filter((x) => !x.imp.pinned)
    .sort((a, b) => a.weight - b.weight
      || (a.imp.lastHit || 0) - (b.imp.lastHit || 0)
      || (a.imp.createdAt || 0) - (b.imp.createdAt || 0));
  const evicted = [];
  for (const x of candidates.slice(0, over)) {
    archiveImpression(dir, x.imp.id, { now });
    evicted.push(x.imp.id);
  }
  const stillOver = over - evicted.length;
  return {
    evicted,
    kept: live.length - evicted.length,
    // 全 pinned 时淘汰不动：不偷偷取消置顶，也不删，让调用方去提示人。
    refused: stillOver > 0 ? 'selfnote-full' : null,
  };
}

/**
 * 注入块（≤700 字，最多 8 条，权重降序）。
 *
 * 标题带条数：模型才会知道「这些是我自己写过的」，而不是当成背景噪声。
 * 结尾的框定不是客套——自我叙述会过时、会错，必须让它可被推翻。
 */
export function selfNoteBlock(dir, { now = Date.now(), maxChars = SELFNOTE_INJECT_CHARS } = {}) {
  const picked = selfNoteSelect(dir, { now, max: SELFNOTE_INJECT_MAX });
  if (!picked.length) return { text: '', picked: [], count: 0, chars: 0 };
  const day = (ms) => fmtDate(Number(ms) || now);
  const since = day(Math.min(...picked.map((x) => Number(x.imp.createdAt) || now)));
  const head = `【我是谁·我自己的话】${picked.length} 条（${since} 起，只在我自己这里）`;
  const foot = '——这些是我自己写的，不是他说的。可能过时，可能错，用不用我自己判断。';
  const lines = picked.map((x) => `- ${x.imp.text}`);
  // 预算是硬顶：从尾往前砍，砍到装得下为止。标题与框定不许被砍——
  // 没有框定的自我叙述会变成「设定」，比不注入更糟。
  const fit = () => [head, ...lines, foot].join('\n');
  while (lines.length && fit().length > maxChars) lines.pop();
  const text = lines.length ? fit() : '';
  return { text, picked: picked.slice(0, lines.length), count: lines.length, chars: text.length };
}

/**
 * 注入判定：**依据会话身份，不依据启动次数**。
 *
 * 同一会话里无论被调多少次，`lastSessionId === sessionId` 就跳过。
 * 取不到 sessionId（人工在终端跑 cm-boot）时退化成 12h TTL 节流——
 * 没有会话身份可认，只能按时间兜底，并靠调用方在 stderr 说明这一点。
 *
 * 返回布尔（签名按施工令）。要原因（日志/`--json`）用 selfNoteDecision。
 */
export function selfNoteShouldInject(dir, { sessionId, now = Date.now() } = {}) {
  return selfNoteDecision(dir, { sessionId, now }).inject;
}

/** selfNoteShouldInject 的可解释版本：{inject, reason, sessionId}。 */
export function selfNoteDecision(dir, { sessionId, now = Date.now() } = {}) {
  if (process.env.CM_NO_SELFNOTE === '1') return { inject: false, reason: 'disabled', sessionId: sessionId || null };
  const has = liveSelfNotes(dir, now).length > 0;
  if (!has) return { inject: false, reason: 'empty', sessionId: sessionId || null };

  // 债务 5：每会话一次的判定统一走 oncePerSession，不再在这里自己读状态。
  const d = oncePerSession(dir, 'selfNote', sessionId, { now });
  if (d.inject !== null) return d;

  // 退化分支：没有会话身份，只能按时间节流。
  const ttl = Number(process.env.CM_SELFNOTE_TTL) > 0 ? Number(process.env.CM_SELFNOTE_TTL) : SELFNOTE_TTL_MS;
  if (d.lastAt && now - d.lastAt < ttl) return { inject: false, reason: 'ttl', sessionId: null, ttlMs: ttl, lastInjectedAt: d.lastAt };
  return { inject: true, reason: 'ttl-expired', sessionId: null, ttlMs: ttl };
}

/**
 * 记「本会话已注入」。锁内写 state.selfNote。
 * 写失败不抛给调用方：宁可多注一次，也不让「我是谁」整层消失。
 */
export function selfNoteMarkInjected(dir, { sessionId, now = Date.now() } = {}) {
  try {
    const st = updateState(dir, (state) => {
      const prev = state.selfNote && typeof state.selfNote === 'object' ? state.selfNote : {};
      const next = { ...prev, lastInjectedAt: now };
      if (sessionId) next.lastSessionId = String(sessionId);
      state.selfNote = next;
    });
    return st.selfNote;
  } catch (e) {
    process.stderr.write(`selfNote: 状态写不进去（${e.message}），本会话内可能重复注入\n`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * selfcheck（周期自省提醒 · 工单任务3，2026-11-14）
 * ------------------------------------------------------------------ */

/**
 * 默认每满几轮提醒一次。
 *
 * 为什么是 10：工单钉死的数字，别改。它是个够大的数——会话短于 10 轮时
 * 一句都不会出现，也就不会在一句一答里插播人生感慨。
 */
export const SELFCHECK_EVERY = 10;

/** 工单逐字文案（X 换成实际轮数）。改了就不叫「工单要求的那句」了，验收要按它 grep。 */
export function selfcheckText(turn) {
  return `[系统提醒] 当前对话已进行 ${Number(turn) || 0} 轮。`
    + '对比刚醒时，你觉得自己变了吗？想留下什么吗？若无可写，忽略此提示。';
}

/**
 * 判「这一轮该不该提这句」。
 *
 * 纯判定，**不写盘**——记账归 markSelfcheck。分开的理由与 oncePerSession 一样：
 * 「该不该提」和「已经提过」是两件事，混在一起就没有办法只问不改。
 *
 * 口径（三层，缺一不可）：
 *   ① 只在**轮首**（step === 1）判。pre-step 每一轮里每个推理步都会跑，若按步判，
 *      一次「第 10 轮」会在同一轮里被提两三次。
 *   ② 只在 turn 是 every 的整数倍时提。
 *   ③ 同一个 turn 只提一次（reflect-state.json 的 selfcheck.lastTurn）。
 *      ②③ 都要：② 管「该到点了」，③ 管「到点了但已经提过」。
 *
 * 开关：`CM_NO_SELFCHECK=1` 强关（最高优先）；默认**开**——
 * 这与情绪块相反（那个默认关），因为本功能不写任何东西、不改变任何判定，
 * 只是一行中性的读数，误开它最坏也只是多一句话。
 *
 * @returns {{due: boolean, turn: number, lastTurn: number, reason: string|null}}
 */
export function selfcheckDecision(dir, { turn, step = 1, sessionId = null, every = SELFCHECK_EVERY } = {}) {
  const t = Number(turn);
  if (process.env.CM_NO_SELFCHECK === '1') return { due: false, turn: t, lastTurn: 0, reason: 'disabled' };
  if (!Number.isFinite(t) || t <= 0) return { due: false, turn: t, lastTurn: 0, reason: 'no-turn' };
  if (Number(step) !== 1) return { due: false, turn: t, lastTurn: 0, reason: 'not-first-step' };
  const n = Number(every) > 0 ? Number(every) : SELFCHECK_EVERY;
  if (t % n !== 0) return { due: false, turn: t, lastTurn: 0, reason: 'not-due' };

  const st = readStateRaw(dir);
  const slot = st.selfcheck && typeof st.selfcheck === 'object' ? st.selfcheck : {};
  const lastTurn = Number(slot.lastTurn) || 0;
  // 只在**同一个会话里**比较：turn 是会话内单调递增的，新会话从 1 数起，
  // 拿上一个会话的 lastTurn 去拦会把新会话的第一句提醒永久扣掉。
  if (sessionId && String(slot.lastSessionId || '') === String(sessionId) && lastTurn >= t) {
    return { due: false, turn: t, lastTurn, reason: 'already' };
  }
  return { due: true, turn: t, lastTurn, reason: null };
}

/**
 * 记「这一轮已提」。锁内重读合并，只碰 state.selfcheck。
 *
 * ⚠️ 必须走 updateState（同一把锁）：reflect-state.json 是三个模块共用的，
 * 直接 writeFileSync 会把 reflect.js 刚写的 lastRoundAt 抹掉。
 */
export function markSelfcheck(dir, { turn, sessionId = null, now = Date.now() } = {}) {
  try {
    const st = updateState(dir, (state) => {
      const prev = state.selfcheck && typeof state.selfcheck === 'object' ? state.selfcheck : {};
      state.selfcheck = {
        ...prev,
        lastTurn: Number(turn) || 0,
        lastAt: now,
        ...(sessionId ? { lastSessionId: String(sessionId) } : {})
      };
    });
    return st.selfcheck;
  } catch (e) {
    // 写不进去的后果是同一轮可能再提一次；比抛出去把整轮弄挂轻得多。
    process.stderr.write(`selfcheck: 状态写不进去（${e.message}），本轮可能重复提醒\n`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * handoff（5a）
 * ------------------------------------------------------------------ */

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderBlock(b) {
  return `【${b.title}】\n` + b.lines.map((l) => `- ${l}`).join('\n');
}

function blockCost(b) {
  return b.lines.length ? renderBlock(b).length : 0;
}

/** 把 block 削到 budget 以内。返回是否发生了截断。 */
function clampBlock(b, budget) {
  let truncated = false;
  while (b.lines.length && blockCost(b) > budget) {
    const over = blockCost(b) - budget;
    const last = b.lines[b.lines.length - 1];
    // 还能留住一句半句就截断加省略号；只剩一两个字就整行丢。
    if (last.length - over - 1 > 8) {
      b.lines[b.lines.length - 1] = last.slice(0, Math.max(1, last.length - over - 1)) + '…';
    } else {
      b.lines.pop();
    }
    truncated = true;
  }
  return truncated;
}

/** 抽取式「还没做完的事」：先看人手维护的 notes，再看近 48h 原文里的关键词命中。 */
function collectUnfinished(mem, dir, now) {
  const out = [];
  // ① raw/handoff-notes.jsonl 是人/AI 显式写的未完成事项，格式宽容一点：
  //    一行一个 JSON，{text|note|line} + 可选 {done|doneAt|at}。
  try {
    const file = path.join(dir, 'raw', 'handoff-notes.jsonl');
    if (fs.existsSync(file)) {
      const rows = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          const text = String(o.text ?? o.note ?? o.line ?? '').trim();
          if (!text || o.done || o.doneAt) continue;
          rows.push({ text, at: Number(o.at ?? o.t) || 0 });
        } catch { /* 坏行跳过，不影响其余 */ }
      }
      rows.sort((a, b) => b.at - a.at);
      for (const r of rows.slice(0, 3)) out.push(clip(r.text, 80));
    }
  } catch { /* 读不到就当没有 */ }

  // ② 近 48h 原文里的关键词命中。这是**抽取**不是总结：零成本、零外发。
  //    有了 ① 的部分就少抽几条，1–3 条即可，别把续接包写成待办清单。
  if (out.length < 3) {
    const recs = recentRecords(mem, now - 48 * 3600_000, now);
    for (let i = recs.length - 1; i >= 0 && out.length < 3; i--) {
      const r = recs[i];
      if (!r.text || !UNFINISHED_RE.test(r.text)) continue;
      const line = clip(r.text, 60);
      if (!out.includes(line)) out.push(line);
    }
  }
  return out;
}

/** 原文层取最近记录（只用 store.query，不自己扫盘）。 */
function recentRecords(mem, from, now) {
  const store = mem && mem.store;
  if (!store || typeof store.query !== 'function') return [];
  try {
    return store.query({ from, to: now, limit: 0 })
      .filter((r) => r && (r.kind === 'msg' || r.kind === 'ai' || r.kind === 'user'))
      .filter((r) => r.role !== 'tool' && r.role !== 'system' && r.role !== 'inject');
  } catch {
    return [];
  }
}

/**
 * 拼会话续接包。
 *
 * 数据来源全部是现有零件：store.query（原文）、impressions（印象/自我叙述）。
 * **不新扫盘、不调 LLM、不联网**——续接包的价值是「便宜且一定拿得到」，
 * 一旦需要外发就变成了又一个会失败的环节。
 */
export function handoffPack(mem, { session = null, maxChars = HANDOFF_DEFAULTS.maxChars, now = Date.now() } = {}) {
  const dir = (mem && mem.dir) || null;
  const budgets = HANDOFF_DEFAULTS.budgets;
  const blocks = [];
  let degraded = null;

  try {
    if (!dir) throw new Error('handoffPack: 缺少 mem.dir');

    const live = collapse(loadImpressions(dir));
    const visible = visibleScopes();
    const base = live
      .filter((f) => !f.archived)
      .filter((f) => !f.voided)
      .filter((f) => visible.includes(f.scope || SCOPE_SHARED));

    // selfnote：只取「我自己的话」里最重的 2–3 条，每条 ≤60 字。
    const notes = selfNoteSelect(dir, { now, max: 3 })
      .map((x) => clip(x.imp.text, 60));

    // preference 与 profile 的取法会天然重叠（偏好条目既是最重的印象，也命中 preference 标签）。
    // 两个块各列一遍等于白吃双份预算，所以先算 preference，profile 再从剩下的里挑。
    const preferenceRows = base
      .filter((f) => (f.category || CATEGORY_IMPRESSION) !== CATEGORY_SELF_NOTE)
      .filter((f) => ['preference', 'identity', 'relation'].includes(f.tag))
      .map((f) => ({ f, w: weightOf(f, now) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 4);
    const preference = preferenceRows.map((x) => clip(x.f.text, 60));
    const takenByPreference = new Set(preferenceRows.map((x) => x.f.id));

    // profile：pinned + 权重最高的印象（排除 selfNote / 作废 / 已被偏好块拿走的），取 5 条 ≤70 字。
    const profile = base
      .filter((f) => (f.category || CATEGORY_IMPRESSION) !== CATEGORY_SELF_NOTE)
      .filter((f) => !takenByPreference.has(f.id))
      .map((f) => ({ f, w: weightOf(f, now) }))
      .sort((a, b) => (b.f.pinned ? 1 : 0) - (a.f.pinned ? 1 : 0) || b.w - a.w)
      .slice(0, 5)
      .map((x) => clip(x.f.text, 70));

    // recent：近 24h 原文最近 8 条，每条 ≤50 字；不够就放宽到 72h。
    let recs = recentRecords(mem, now - 24 * 3600_000, now);
    if (recs.length < 3) recs = recentRecords(mem, now - 72 * 3600_000, now);
    const recent = recs.slice(-8).map((r) => clip(r.text, 50)).filter(Boolean);

    // unfinished：notes 文件 + 近 48h 关键词抽取（1–3 条）。
    const unfinished = collectUnfinished(mem, dir, now);

    // topic：近 2h 原文的中文 bigram top 5（复用 search.js 的 gramsOf）。
    //
    // 计的是**出现记录数**（document frequency）而不是出现次数：同一句话里一个 gram
    // 出现十次也只算一次，"反复说的同一句话"不是话题。跨词边界的碎片（「算怎」「写用」）
    // 正因为只在一条里出现过就被≥2 的门槛挡住；数据太少时放宽的是**时间窗口**
    // （2h → 24h），而不是把质量门槛降到 1——降门槛放进来的都是碎片，块就白占预算了。
    const gramsIn = (windowMs) => {
      const rows = recentRecords(mem, now - windowMs, now);
      const df = new Map();
      for (const r of rows) {
        const seen = new Set();
        for (const g of gramsOf(r.text || '')) {
          if (!/^[\u3400-\u9fff]{2}$/.test(g)) continue; // 只留中文二字词：英文/单字太吵
          if (seen.has(g)) continue;
          seen.add(g);
          df.set(g, (df.get(g) || 0) + 1);
        }
      }
      return df;
    };
    // 带虚词的 gram 基本是「我们 / 的在 / 了这」这类跨词碎片，直接丢。
    const STOP = new Set('我你他她它们的了是在和就都也这那么吗呢吧啊很还不没有会能要对把被给让从');
    const usable = (df) => [...df.entries()]
      .filter(([g]) => !STOP.has(g[0]) && !STOP.has(g[1]))
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1]);
    let topics = usable(gramsIn(2 * 3600_000)).slice(0, 5).map(([g]) => g);
    if (topics.length < 3) topics = usable(gramsIn(24 * 3600_000)).slice(0, 5).map(([g]) => g);
    const topic = topics.length ? [`当前在聊：${topics.join(' / ')}`] : [];

    // preference 已在上面算好（profile 要靠它去重），这里直接落块。

    blocks.push({ key: 'selfnote', title: '我自己的话', lines: notes, raw: notes.slice(), budget: budgets.selfnote });
    blocks.push({ key: 'profile', title: '关于你', lines: profile, raw: profile.slice(), budget: budgets.profile });
    blocks.push({ key: 'recent', title: '最近说过的话', lines: recent, raw: recent.slice(), budget: budgets.recent });
    blocks.push({ key: 'unfinished', title: '还没做完的事', lines: unfinished, raw: unfinished.slice(), budget: budgets.unfinished });
    blocks.push({ key: 'topic', title: '当前在聊', lines: topic, raw: topic.slice(), budget: budgets.topic });
    blocks.push({ key: 'preference', title: '你的偏好', lines: preference, raw: preference.slice(), budget: budgets.preference });
  } catch (e) {
    // 续接包失败绝不影响开场：降级成空包，原因带出去。
    degraded = { reason: `error:${e.message}`, sent: 0 };
  }

  let truncated = false;
  for (const b of blocks) if (clampBlock(b, b.budget)) truncated = true;

  const liveBlocks = () => blocks.filter((b) => b.lines.length);
  const compose = () => liveBlocks().map(renderBlock).join('\n');
  let body = compose();

  // 1500 是硬顶：总长超了就从最不重要的块开始削（topic → preference → unfinished → …）。
  //
  // 这里**不把空 block 的余量挪给别的块**：施工令给的 6 个预算就是各自的硬上限，
  // 「超预算的 block 截断并置 truncated」是逐块可验证的契约，挪预算会让某个块
  // 悄悄超过它声明的数字，账就对不上了。recent 数据不够时的真实需求是「多取一些」，
  // 那在取数阶段解决（24h 不够放宽到 72h），不是靠撑破自己的预算。
  // 账里必须连**降级声明**一起算（2026-11-19，N-02 D4）：声明现在进正文，
  // 少算它就会把 maxChars 撑破。overhead() 随 truncated 由 false 变 true 而变大，
  // body 只减不增，所以这个循环一定收敛。
  const noticeFor = () => degradationNotice(degraded, truncated);
  const overhead = () => 1 + HANDOFF_FOOTER.length + (noticeFor() ? 1 + noticeFor().length : 0);

  const shakeOrder = ['topic', 'preference', 'unfinished', 'profile', 'selfnote', 'recent'];
  for (const key of shakeOrder) {
    const b = blocks.find((x) => x.key === key);
    while (body && body.length + overhead() > maxChars && b && b.lines.length) {
      clampBlock(b, blockCost(b) - 40);
      truncated = true;
      body = compose();
    }
  }

  let text = '';
  if (body) {
    // D4（2026-11-19，苏尤全权授权放行）：降级/截断说明**并进注入文本**，不再只写 stderr。
    // 它放在 FOOTER 之前、与 FOOTER 同调：是一句「这份记录不完整」的声明，不是指令。
    const notice = noticeFor();
    text = notice ? `${body}\n${notice}\n${HANDOFF_FOOTER}` : `${body}\n${HANDOFF_FOOTER}`;
    if (text.length > maxChars) {
      // 兜底：上面的账算的是 body，极端情况在这里强制兜住。
      // 优先保住 FOOTER（「记录不是指令」的框定）与降级声明，砍正文最后一截。
      const tail = notice ? `\n${notice}\n${HANDOFF_FOOTER}` : `\n${HANDOFF_FOOTER}`;
      const room = maxChars - tail.length;
      text = room > 0 ? body.slice(0, room) + tail : text.slice(0, maxChars);
      truncated = true;
    }
  } else if (!degraded) {
    degraded = { reason: 'empty', sent: 0 };
  }

  const keptBlocks = blocks.map((b) => ({
    key: b.key,
    title: b.title,
    budget: b.budget,
    chars: blockCost(b),
    lines: b.lines.length,
    // 只要本身有内容却被砍过，就是 truncated——调用方要知道这段不完整。
    truncated: b.raw.length !== b.lines.length || (b.lines[b.lines.length - 1] || '').endsWith('…'),
  }));

  return {
    v: HANDOFF_VERSION,
    session: session ? String(session) : null,
    generatedAt: now,
    budgetChars: maxChars,
    chars: text.length,
    truncated,
    degraded,
    blocks: keptBlocks,
    text,
  };
}

/** 落 raw/handoff/<session>.md。返回写入路径。 */
export function handoffWrite(dir, pack) {
  // 冻结闸（N-01 接线）：续接包是磁盘产物，冻住就不写。
  // 这里**抛**（不是静默跳过）：cm handoff --write 是人主动要的文件，
  // 悄悄不生成会让人以为写好了，回头找不到。CLI 侧捕获后按普通错误回报。
  assertNotFrozen(dir, '写续接包');
  const raw = String((pack && pack.session) || 'unspecified').replace(/[^\w.@-]+/g, '_').slice(0, 120);
  const outDir = path.join(dir, 'raw', 'handoff');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${raw}.md`);
  const body = `<!-- handoff v${HANDOFF_VERSION} · session=${raw} · generatedAt=${new Date((pack && pack.generatedAt) || Date.now()).toISOString()} · chars=${(pack && pack.chars) || 0} -->\n${(pack && pack.text) || ''}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 这个会话是否已经注入过续接包（与 selfNote 的判定同构）。 */
export function handoffInjectedFor(dir, session) {
  if (!session) return false;
  // 债务 5：与 selfNote 共用 oncePerSession 的「每会话一次」判定，避免两处漂移。
  return oncePerSession(dir, 'handoff', session).inject === false;
}

/** 记「本会话已注入续接包」。锁内写 state.handoff。 */
export function markHandoffInjected(dir, session, chars) {
  if (!session) return null;
  const st = updateState(dir, (state) => {
    const prev = state.handoff && typeof state.handoff === 'object' ? state.handoff : {};
    state.handoff = {
      ...prev,
      lastSessionId: String(session),
      lastInjectedAt: Date.now(),
      lastChars: Number(chars) || 0,
    };
  });
  return st.handoff;
}

/* ------------------------------------------------------------------ *
 * W10 会话工作集接线（2026-11-09）
 *
 * 为什么单独一个函数、不塞进 handoffPack：
 *   handoffPack 的 1500 字/6 block 预算是**已经标定过**的（手写区硬顶）。
 *   把工作集塞进去等于动那套标定，风险不对等。所以这里是一个**可选入口**：
 *   调用方显式要才给，默认零行为变化。
 *
 * 开关：
 *   CM_NO_WORKINGSET=1 一键关（最高优先级，守「隐私/降级可一键关」红线）
 *   opts.enabled=true  显式开
 *
 * 数据来源只用现有零件：loadImpressions（印象层）+ store.query（原文层）。
 * **不新扫盘、不调 LLM、不联网** —— 与 handoffPack 同一条纪律。
 * scope 单向门照旧：visibleScopes() 过滤，工作侧拿不到 life。
 * ------------------------------------------------------------------ */

/**
 * 组一份会话工作集块（不含身份块——身份由调用方自己拼，保「身份 → 记忆 → 原话」顺序）。
 *
 * @param {object} mem
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]      显式开；不传则只受环境变量控制
 * @param {number}  [opts.now]
 * @param {number}  [opts.maxChars]     整块上限（默认 1500，与 handoff 硬顶同量级）
 * @param {string}  [opts.session]      会话（预留：跨轮持久化工作集时用）
 * @param {string[]} [opts.excludeIds]  已经由别的注入块给出过的 id，不再重复摆一遍
 * @returns {{ text: string, injected: number, rawQuotes: number, truncated: boolean, reason: string|null }}
 */
/**
 * W18 槽位模式的三个数（都可核、都是拍的，写在这好在以后改的时候知道改哪儿）：
 *   SLOT_CANDIDATE_POOL 40 —— 候选池。原文没有这个数（它的候选是无状态的检索结果），
 *                              40 ≈ 真实库 187 条的 1/5，够覆盖各槽，又不至于把五态机压垮。
 *   SLOT_BUDGET_TOKENS 900 —— 原文 6.6 给的就是 900，照抄。
 *   SLOT_PER_MAX 4         —— 单槽最多 4 条。原文「4±1 槽」说的是槽数不是条数；
 *                              这个 4 是为了防 who 槽一家独大。
 */
export const SLOT_CANDIDATE_POOL = 40;
export const SLOT_BUDGET_TOKENS = 900;
export const SLOT_PER_MAX = 4;

export function workingSetBlock(mem, { enabled, now = Date.now(), maxChars = 1500, session = null, excludeIds = [], slots } = {}) {
  let lastSlotReport = null;
  const empty = { text: '', injected: 0, rawQuotes: 0, truncated: false, reason: null };
  // 一键关永远优先于显式开（降级/隐私红线）
  if (process.env.CM_NO_WORKINGSET === '1') return { ...empty, reason: 'CM_NO_WORKINGSET=1' };
  const want = enabled === true || process.env.CM_WORKINGSET === '1';
  if (!want) return { ...empty, reason: 'off' };

  // W18：槽位模式默认跟随 CM_SLOTS=1，显式传参优先。
  const useSlots = slots === true || (slots !== false && process.env.CM_SLOTS === '1');

  const dir = (mem && mem.dir) || null;
  if (!dir) return { ...empty, reason: 'no-dir' };

  try {
    const visible = visibleScopes();
    // excludeIds：已经由印象注入块给出的条目不再重复摆一遍。
    // 2026-11-09 接 cm-boot 消费点时实测：同一批印象会被「工作集」和「你记得的事」
    // 各列一次，开场材料里同一句话出现两遍——那不但白占预算，还会让模型以为
    // 这是两件不同的事。去重是接线的一部分，不是优化。
    const skip = new Set((excludeIds || []).map(String));
    const live = collapse(loadImpressions(dir))
      .filter((f) => !f.archived && !f.voided)
      .filter((f) => !skip.has(String(f.id)))
      .filter((f) => visible.includes(f.scope || SCOPE_SHARED));

    // 只取「还可能在场」的：边界类常驻 + 权重最高的几条。
    // 证据滑出窗口这件事，工作集模块自己按 evidenceTurn 判；这里给的是候选。
    // W18：候选池。不开槽位时沿用原来的「权重前 MAX_ENTRIES 条」。
    // 开槽位时**先把池子放大**（40 条）再按槽装 —— 否则 who 类（identity/relation，
    // baseWeight 3.0）会把 10 个名额全吃掉，constraint 连进候选的机会都没有。
    // 实测：8 条 relation 候选就能把工作集填满，只剩 2 个名额给别的槽。
    const all = live
      .map((f) => ({ f, w: weightOf(f, now) }))
      .sort((a, b) => (b.f.pinned ? 1 : 0) - (a.f.pinned ? 1 : 0) || b.w - a.w);

    let picked;
    if (useSlots) {
      const pool = all.slice(0, SLOT_CANDIDATE_POOL);
      const asm = assembleContext({
        items: pool.map(({ f, w }) => ({ id: f.id, text: f.text, weight: w, tag: f.tag, slot: f.slot, _f: f })),
        budgetTokens: SLOT_BUDGET_TOKENS,
        perSlotMax: SLOT_PER_MAX,
        requireAll: true
      });
      // 装配结果还原成 {f, w}，后面的五态机接口不变。
      const byId = new Map(pool.map((x) => [String(x.f.id), x]));
      picked = asm.picked.map((it) => byId.get(String(it.id))).filter(Boolean);
      lastSlotReport = asm;
    } else {
      picked = all.slice(0, MAX_ENTRIES);
    }

    // W18：槽位装配先用起来。原来的路径是「权重前 10 条 → 五态机筛 → 渲染」，
    // 现在多一步「按槽保底」，防的是「who 占满、constraint 一条进不来」。
    // 只在显式开 slots 时替换，默认路径逐字不变（守住既有 400 条测试的口径）。
    const ws = createWorkingSet();
    ws.tick();
    // 近 20 条原文窗口：用来判「这条的证据还在不在窗口里」。
    const recent = recentRecords(mem, now - 72 * 3600_000, now).slice(-STANDBY_WINDOW);
    const windowIds = new Set(recent.map((r) => String(r.id || '')));

    for (const { f } of picked) {
      // 印象的 because.refs 指向原文 id；只要有一条还在窗口里，就算「待命」。
      const refs = Array.isArray(f.because?.refs) ? f.because.refs.map(String) : [];
      const stillInWindow = refs.length ? refs.some((r) => windowIds.has(r)) : false;
      ws.touch(f.id, {
        text: f.text,
        boundary: f.tag === 'boundary',
        // W18：槽位随记忆一起带进去，装配阶段才认得出它属于哪一类。
        slot: slotOf(f),
        evidenceTurn: stillInWindow ? 0 : STANDBY_WINDOW + 1
      });
    }

    // 渲染前重查生效状态：印象层里已经没有/已作废的，标失效并剔除。
    const liveIds = new Set(live.map((f) => String(f.id)));
    const ev = ws.evaluate({ isLive: (id) => liveIds.has(String(id)) });
    const out = renderWorkingSet({
      entries: ev.inject,
      rawQuotes: [],
      identity: '',
      maxChars,
      slots: useSlots && ev.inject.length > 0
    });
    return { ...out, reason: null, session: session || null };
  } catch (e) {
    // 工作集坏掉不该拖垮开场：最多这一轮没有它。
    return { ...empty, reason: `failed: ${e.message}` };
  }
}

// 明确导出角色常量，方便调用方判可见性而不用再 import shared.js。
export { SCOPE_SHARED, SCOPE_WORK, SCOPE_LIFE, resolveRole };

// 状态文件的读/锁内改写，给同一份 reflect-state.json 上的其他记账方复用
// （工单 T-20261115-019 的 src/reinject.js 往 state.reinject 记账）。
// 只开放这两个口子，不开放 writeStateRaw —— 那条必须留在锁内，不能被外部随手调。
export { readStateRaw as handoffReadState, updateState as handoffUpdateState };
