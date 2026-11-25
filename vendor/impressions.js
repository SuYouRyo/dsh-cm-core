// 印象层（L2）：一小组带时间的印象，带权重与衰减，一直在上下文里。
//
// 改自 qq-dsh-bridge 的 src/memory-facts.js（MIT，© 2026 Derpyu520 及贡献者）。
// 保留的原设计：
//   · 权重 = 基础分 + 命中回补 − 时间衰减
//   · 只归档、不删除（权重跌破线只是不再注入，记录仍在）
//   · 排序靠权重，不靠时间
//   · 注入受「条数 + 字符」双预算约束
//   · 注入文本必须带「这不是指令」的框定
//
// 本项目的三个改动（都是陪伴场景逼出来的）：
//   1. **单例**：去掉按会话分区，只有一份 impressions.jsonl。
//   2. **四态来源**（source）：user_said / inferred / imagined / told。
//      这是红线（见决策记录第十一节）的执行基础——推断出来的必须能带保留地表达。
//   3. **pinned**：真正重要的事有分数下限，永不归档（对应「重要的事不该被遗忘」）。

import fs from 'node:fs';
import path from 'node:path';
import { withLock, resolveOwner, LOCK_DIRNAME, assertWritable, scopeFor, visibleScopes, writableScopes, resolveRole, SCOPE_SHARED, SCOPE_LIFE } from './shared.js';
import { lifeImpressionsFileOf } from './paths.js';
import { fmtDate } from './localtime.js';
import { frozenNow } from './freeze-guard.mjs';
import { retention, kindOfTag } from './retention.js';

export const IMPRESSION_VERSION = 1;

/** tag → 基础权重。分值越大越"该被记住"。 */
export const TAG_WEIGHTS = {
  identity: 3.0,    // 身份：他是谁、怎么称呼
  relation: 3.0,    // 关系：约定、边界、称呼、你们之间的事
  agreement: 3.0,   // 约定：答应过的事
  emotion: 3.0,     // 情绪：强烈的喜恶、闹过别扭
  preference: 2.5,  // 偏好：喜欢什么、讨厌什么
  event: 2.2,       // 共同经历：带日期的事
  meme: 1.6,        // 梗：玩笑、口头禅
  misc: 1.3         // 琐事
};

/** 四态来源。这是红线的一部分，不要扩展成「无所谓」。 */
export const SOURCES = {
  user_said: '他说过的',
  inferred: '我推的',
  imagined: '我猜的',
  told: '别人告诉我的'
};

/**
 * 来源可靠性（W14，2026-11-13）——取《双脑记忆系统》4.6 的分层：
 * 亲历 1.0 / 文档 0.8 / 转述 0.6 / 推断 0.4 / 模型 0.2。
 *
 * 我们只有四态来源，映射：
 *   user_said  他说过的      = 亲历 → 1.0
 *   told       别人告诉我的  = 转述 → 0.6
 *   inferred   我推的        = 推断 → 0.4
 *   imagined   我猜的        = 模型/臆测 → 0.2
 *
 * **只作用于「证据奖励」部分，不乘 baseWeight。**
 * 为什么：直接乘 base 会把 62 条 imagined 从 3.0 压到 0.6，全部跌破归档线 1.0，
 * 下一次 reapArchived 就把它们归档掉——用户会感到「记忆突然空了」，
 * 而那不是可靠性分层的本意。来源决定的是「这条有多硬的证据」，不是「这条重不重要」。
 */
export const SOURCE_RELIABILITY = {
  user_said: 1.0,
  told: 0.6,
  inferred: 0.4,
  imagined: 0.2
};

/**
 * 证据奖励（W14）：每条**独立事件**算一份，按来源可靠性打折。
 *
 * 《双脑记忆系统》4.6 原文：`evidence_count = distinct(event_id)`。
 * 「同一事件召回一百次仍只是一条证据」——这就是本组常量的全部理由。
 * 上限 EVIDENCE_BONUS_CAP 与旧 HIT_BONUS_CAP 同为 1.5，
 * 保证「再被用也压不过身份层 3.0」，排序体系不塌。
 */
export const EVIDENCE_BONUS = 0.5;
export const EVIDENCE_BONUS_CAP = 1.5;
/** 归档线：低于它就不再注入（但不删）。 */
// 印象的两类。category 缺省 = 'impression'（老记录没有这个字段）。
// selfNote 是 L4「自我认知层」：AI 用自己的话写的关于它自己的那些条。
// 两者共用同一个 jsonl、同一把锁、同一套衰减，但注入时机和预算完全分开。
export const CATEGORY_IMPRESSION = 'impression';
export const CATEGORY_SELF_NOTE = 'selfNote';

export const ARCHIVE_THRESHOLD = 1.0;
/** pinned 的下限：再多时间也压不到这条线以下。 */
export const PINNED_FLOOR = 2.0;
/** 单次注入条数上限。 */
export const INJECT_MAX = 40;
/** 注入文本的字符预算。 */
export const INJECT_MAX_CHARS = 1200;

/**
 * 清晰度状态（D1，2026-11-20）。
 *
 * 缺口原文（2026-11-09 §14.2 第 1 条）：
 *   「衰减只有连续权重，没有清晰度状态 —— 143 条活跃印象抢 40 个注入名额，
 *    没被注入的照样衰减=抽签；做不出『一次只降一档、被提到就升回去』。」
 *
 * 权重说的是一件事「现在还值多少分」，清晰度说的是另一件事「这条被记成了什么样子」。
 * 只有连续权重时，一条 40 天没被提到的琐事会直接从 1.3 掉到归档线以下、一次性消失；
 * 而真实记忆不是这样退场的 —— 它先变模糊、再只剩印象、最后才想不起来。
 *
 * 五档沿用 dsh-local-memory/card-engine.mjs 的 CLARITY_ORDER（清晰→已遗忘）。
 * **本仓没有「真删除」**：'forgotten' 只表示「不再注入」，落地动作是 archived，记录仍在。
 * 这条与 reapArchived 头注的红线一致，不要为了「彻底忘掉」加删除。
 *
 * pinned 永久豁免（对应 card-engine 的 pinned）：档位恒为 vivid，reap 不碰。
 */
export const CLARITY_ORDER = Object.freeze(['vivid', 'clear', 'fuzzy', 'trace', 'forgotten']);
export const CLARITY_LABEL = Object.freeze({
  vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '只剩印象', forgotten: '已遗忘'
});
/** 定档门槛：权重 ≥ vivid 进「清晰」，≥ clear 进「清楚」，≥ 归档线进「模糊」，否则「已遗忘」。 */
export const CLARITY_VIVID_MIN = 2.4;
export const CLARITY_CLEAR_MIN = 1.7;

export function impressionsFileOf(dir) {
  return path.join(dir, 'impressions', 'impressions.jsonl');
}

/**
 * 印象层的文件选择（丙方案，2026-11-21）。
 *
 * 为什么印象层也要分两份：impressions.jsonl 是被 git 追踪的文件，
 * 远端 pre-receive 钩子只要在被追踪的字节里看到 "scope":"life" 就整推拒收。
 * 生活侧在本机是实时写库的（实测 2026-11-21 13:09 还在写），
 * 所以「一次性把历史洗干净」永远追不上 —— 只能让 life 一开始就落在另一个文件里。
 * 那个文件在 .gitignore 里（见 bin/cm-remote.js 的 LOCAL_ONLY），不会进同步仓。
 *
 * 不传 scope（或传 shared/work）→ 还是老文件，老调用方行为一字不变。
 */
export function impressionsFileForScope(dir, scope) {
  return (scope || SCOPE_SHARED) === SCOPE_LIFE ? lifeImpressionsFileOf(dir) : impressionsFileOf(dir);
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function newId() {
  return `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 证据账本（W14）：把一条印象的「证据」算成**独立事件数**，不是命中次数。
 *
 * 《双脑记忆系统》4.6 原文：`evidence_count = distinct(event_id)`，
 * 「同一事件召回一百次仍只是一条证据」。
 *
 * 改之前这里读的是 `imp.hits` —— 而那是个浮点累加器，
 * 由 `touchInjected` 每次「把这条摆进上下文」加 0.3 写出来。
 * 后果是：被注入得越多 → 分越高 → 越容易被注入 → 分更高（正反馈）。
 * 真实库实测 max 3.2999999999999994，那不是「被证明了 3.3 次」，
 * 是「被塞进过上下文 11 次」——两件事的语义完全不同。
 *
 * 现在的口径：
 *   · `evidenceIds`  —— 真正支撑这条的事件 id 数组，**按集合去重**
 *   · `evidenceCount`—— 上面那个集合的大小
 *   · 奖励按来源可靠性打折（`SOURCE_RELIABILITY`）
 *
 * @returns {{ids: string[], count: number, reliability: number, bonus: number}}
 */
export function evidenceOf(imp) {
  const raw = Array.isArray(imp?.evidenceIds) ? imp.evidenceIds : [];
  // 去重必须在这里做，不指望写入方。同一事件被 append 两次、或调用方手抖重复传，
  // 都不该让证据数变多——「distinct」的意思就是数多少个不同的东西。
  const ids = [...new Set(raw.filter(Boolean).map(String))];
  const count = ids.length;
  const reliability = SOURCE_RELIABILITY[imp?.source] ?? SOURCE_RELIABILITY.user_said;
  const bonus = Math.min(EVIDENCE_BONUS_CAP, count * EVIDENCE_BONUS * reliability);
  return { ids, count, reliability, bonus };
}

/** 只取证据数（外部最常用的口径）。 */
export function evidenceCountOf(imp) {
  return evidenceOf(imp).count;
}

/**
 * 当前有效权重。
 *
 * 2026-11-13 W14/W15 改写，三处语义变化，都在注释里留了原委：
 *
 * ① **命中回补 → 证据奖励**。不再读 `hits`（那是注入计数器），改读 `evidenceIds`。
 *    注入不再影响权重——「被摆进上下文」和「这件事被证实了」是两回事。
 *
 * ② **衰减改由 retention.js 统一算**。之前是阶梯式（每 3 天 0.1，floor 取整），
 *    与检索层的指数式并存，同一条记忆两个模块给出两种「还剩多少」。
 *    现在两边都走 `retention()`，量纲统一为「保留比例」，乘回 base。
 *
 * ③ `lastInjectedAt` / `hitBumpedAt` **不再参与分数**，只当轮换游标用
 *    （见 selectForInjection 的同档轮换）。它们记录的是使用史，不是重要性。
 *
 * @param {object} imp
 * @param {number} [now]
 * @returns {number} 权重
 */
export function weightOf(imp, now = Date.now()) {
  const base = Number.isFinite(imp.baseWeight) ? imp.baseWeight : (TAG_WEIGHTS[imp.tag] ?? TAG_WEIGHTS.misc);
  // 作废 = 这条已被判定不成立了。给 0 不是"权重最低"，是"不该被选中说话"——
  // 衰减到底的老印象还能靠 pinned 拉回来，作废的不行：它是被明确否掉的内容。
  if (imp.voided) return 0;

  const ev = evidenceOf(imp);
  const from = Number(imp.lastHit ?? imp.createdAt ?? now);
  // 承诺（agreement）永不过期 → retention 恒 1，等价于不做衰减。
  const keep = retention({ from, now, kind: kindOfTag(imp.tag), tag: imp.tag, nEff: ev.count });

  // 基础部分按保留率折算；证据奖励**不打折**——
  // 「有三条独立证据」这件事本身不会随时间变弱，变质的是记忆的鲜活度，不是它的根据。
  const decayed = base * keep;
  const w = decayed + ev.bonus;

  // 存疑：还没被否掉，但已知可能不准。扣分而不是排除——
  // 排除等于替用户下判断，扣分只是让它排在后面、并且注入时带「存疑」标记。
  const adjusted = imp.suspect ? Math.max(0.1, w - 0.3) : w;
  return imp.pinned ? Math.max(PINNED_FLOOR, adjusted) : adjusted;
}

/** 档位下标（0=清晰 … 4=已遗忘）；不认识的档位返回 -1（表示「没有这个字段」）。 */
export function clarityIndexOf(clarity) {
  return CLARITY_ORDER.indexOf(String(clarity ?? ''));
}

/**
 * 「按当前权重，这条**应该**在哪一档」——目标档，不是当前档。
 *
 * 只看权重，不看历史：这是唯一不引入第二套衰减口径的算法。
 * pinned 恒 vivid（永久豁免）；作废 → 权重 0 → forgotten（作废本来就不该被注入）。
 */
export function clarityTargetOf(imp, now = Date.now()) {
  if (imp && imp.pinned) return 'vivid';
  const w = weightOf(imp, now);
  if (w >= CLARITY_VIVID_MIN) return 'vivid';
  if (w >= CLARITY_CLEAR_MIN) return 'clear';
  if (w >= ARCHIVE_THRESHOLD) return 'fuzzy';
  return 'forgotten';
}

/**
 * 当前档位。
 *
 * 没有 clarity 字段（老记录、以及刚写下还没经历过第一轮 reap 的记录）→ 按当前权重回填。
 * 为什么不在 addImpression 里当场定档：定档的含义是「经过时间检验后它变成了什么样」，
 * 刚写下就写死一档，等于把「刚说完的话」和「三个月没再提起的话」记成同一件事。
 * 回填 ≠ 伪造历史：它只是把「此刻它该在哪一档」写成显式字段，此后才开始一档一档地降。
 */
export function clarityOf(imp, now = Date.now()) {
  const i = clarityIndexOf(imp && imp.clarity);
  if (i >= 0) return CLARITY_ORDER[i];
  return clarityTargetOf(imp, now);
}

/**
 * 读印象层。
 *
 * 丙方案（2026-11-21）后印象层有两个文件：被追踪的 impressions.jsonl（shared/work）
 * 与本机专属的 impressions-life.jsonl（life）。**必须两个都读**，
 * 否则生活侧回忆不到自己说过的话、工作侧的「这条被接替过」也会看不到。
 *
 * 读序：先被追踪的那份、后 life 那份。同 id 以最后一条为准（collapse 的既有口径），
 * 所以 life 的修订行落在后面 —— 这与 store.readShardRecords 的「冷 → life → 主热」同一原则：
 * 谁最后追加谁算最新。
 */
export function loadImpressions(dir) {
  const out = [];
  for (const file of [impressionsFileOf(dir), lifeImpressionsFileOf(dir)]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

/** 折叠修订记录：同 id 以最后一条为准。 */
export function collapse(records) {
  const map = new Map();
  for (const r of records) if (r && r.id) map.set(r.id, r);
  return [...map.values()];
}

/**
 * 修订号（D5，2026-11-20）。
 *
 * 缺口原文（§14.2 第 5 条）：「印象/知识无修订号与 CAS —— append-only + collapse() 取最后一条，
 * 靠代码自觉；无版本号、无『期望版本不符即拒写』。」
 *
 * 口径：**文件里这个 id 追加一行，rev 就 +1**（含自动定档这类系统修订）。
 * 为什么把系统修订也算进去：rev 描述的是「这条记录被追加过几次」，
 * 不是「内容被人工改过几次」。把系统修订排除在外，就得再维护一个字段，
 * 而两个计数器一定会漂——这是本仓反复踩过的坑（见 W14 的 hits 与 injectedCount）。
 *
 * 老记录没有 rev 字段 → 按 1 算（它们本来就只追加过一次）。
 */
export function revOf(imp) {
  const n = Math.floor(Number(imp && imp.rev));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** CAS 冲突：调用方看到的 rev 已经不是最新的（别人先改过），本次写入被拒。 */
export class RevisionConflictError extends Error {
  constructor(id, expected, actual) {
    super(`修订冲突：${id} 期望 rev ${expected}，实际 rev ${actual}（这条已被别人改过，请重新读一次再改）`);
    this.name = 'RevisionConflictError';
    this.code = 'CM_REV_CONFLICT';
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * 按修订号写入（D5 的 CAS 入口）。
 *
 * 语义：`expectRev` 给了就核对最新一行的 rev，不等直接抛 RevisionConflictError、**一个字节都不写**；
 * 不给就是无条件追加（老调用方的用法）。
 *
 * 为什么 CAS 在这里有意义：文件是 append-only、跨端靠 git 同步，
 * 「先读到 rev 3，写的时候其实已经是 rev 5」是真实会发生的（手机与电脑同时在写）。
 * 没有 CAS 时这种情况会被 collapse() 静默压成后写者赢 —— 前一个人改的内容看起来「没生效」，
 * 而没有任何人说得出为什么。
 *
 * @returns {object|null} 修订后的完整记录；id 不存在返回 null
 */
export function reviseImpression(dir, id, patch = {}, { now = Date.now(), expectRev = null } = {}) {
  assertWritable('修订印象', undefined, dir);
  const doRevise = () => {
    const target = loadImpressions(dir).filter((f) => f.id === id).pop();
    if (!target) return null;
    // 修订行必须写回这条记录**自己**那一份文件（丙方案）：
    // 把 life 的修订行写进被追踪的文件，等于把 "scope":"life" 又塞回同步仓。
    const file = impressionsFileForScope(dir, target.scope);
    ensureDir(file);
    const actual = revOf(target);
    const expected = expectRev === null || expectRev === undefined ? null : Math.floor(Number(expectRev));
    if (expected !== null && expected !== actual) throw new RevisionConflictError(id, expectRev, actual);
    const next = { ...target, ...patch, rev: actual + 1, revisedAt: now };
    fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
    return next;
  };
  if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return doRevise();
  return withLock(dir, doRevise);
}

/**
 * 版本链索引（W16，2026-11-13）。
 *
 * 来源：《双脑记忆系统》6.3「版本链再巩固」。原文要的是：
 *   新版本 `new_version.supersedes = old.id`，`store.append` 追加，**旧版保留**。
 *
 * 这跟我们原来的做法差在哪：
 *   原来「这条不成立了」只能靠 `voided`（作废）—— 那是一次**归零**，
 *   旧的从权重 0 直接退出一切。但「他以前不骑车，现在又骑了」不是「以前那句是假的」，
 *   它是「以前那句已经过期，但它仍然是当时的事实」。voided 表达不了这种区别。
 *
 * 现在的语义：
 *   · `supersedes: 'old_id'` —— 新的这条声明它接替谁
 *   · 被接替的那条打上 `supersededBy: 'new_id'` 与 `stale: true`
 *   · **不删、不作废**，权重照算，只是降到附属位、注入时带「已更新」标记
 *   · 检索时旧条仍然返回 —— 问「他以前骑不骑车」时旧条才是答案
 *
 * ⚠️ 不做自动推断。原文靠 `PE > θ_pe or novelty > θ_novelty` 触发再巩固，
 * 我们**没有 PE 计算器也没有 novelty 估计器**。自己编一个阈值去猜「这两句话是同一件事的
 * 两个版本」，猜错了就是**抹掉真实历史**。所以只留显式入口：调用方说了算。
 * 这条写进工单的「红线区」，以后别为了"智能一点"偷偷加个文本相似度判断。
 */

/**
 * 印象的展示短码（W19，2026-11-13）。
 *
 * 为什么不是直接用完整 id：`i_mw01ae4h_e7jmf` 有 16 个字符，
 * 40 条就是 640 字符，直接把 1200 字符的注入预算吃掉一半。
 *
 * 取 id 末段最后 6 位（`e7jmf` 那段是随机后缀，重复率极低）；
 * 万一撞了，`resolveShortId` 会返回多于一个候选，调用方可以要求给全长。
 */
export function shortIdOf(id) {
  const s = String(id || '');
  const tail = s.split('_').pop() || s;
  return tail.slice(-6) || s.slice(-6);
}

/**
 * 短码 → 完整 id。撞码时返回多个候选，**绝不猜**。
 * @returns {{ok:boolean, id?:string, candidates?:string[], reason?:string}}
 */
export function resolveShortId(dir, short) {
  const key = String(short || '').trim();
  if (!key) return { ok: false, reason: '短码为空' };
  const all = collapse(loadImpressions(dir));
  const hits = all.filter((f) => shortIdOf(f.id) === key || String(f.id) === key);
  if (hits.length === 1) return { ok: true, id: hits[0].id };
  if (hits.length > 1) {
    return { ok: false, candidates: hits.map((f) => f.id), reason: `短码 ${key} 对应 ${hits.length} 条，请用完整 id` };
  }
  return { ok: false, reason: `没有短码为 ${key} 的印象` };
}

/** 返回 Map<旧id, 新id>：谁被谁接替了。同一条被多次接替时取**链条末端**。 */
export function supersedeIndex(records) {
  const map = new Map();
  for (const r of records) {
    if (r && r.supersedes) map.set(String(r.supersedes), r.id);
  }
  // 沿链走到底：A←B←C 时，A 最终被 C 接替。
  const resolve = (id) => {
    let cur = id;
    const seen = new Set();
    while (map.has(cur) && !seen.has(cur)) { seen.add(cur); cur = map.get(cur); }
    return cur;
  };
  const out = new Map();
  for (const oldId of map.keys()) out.set(oldId, resolve(oldId));
  return out;
}

/**
 * 版本链深度：这条被"接力"过几手（0 = 最新一代）。
 *
 * ⚠️ 这里必须用**原始** supersedes 映射，不能用 supersedeIndex() 的 resolve 结果。
 * resolve 会把 A→B→C 直接压成 A→C，那样每一跳都只算 1 层，
 * 三代链条就数成 1 —— 我第一次写就是这么错的，测试当场抓住（W16④）。
 * 深度要的是「隔了几代」，所以必须逐跳走。
 */
export function versionDepthOf(id, records) {
  const raw = new Map();
  for (const r of records) {
    if (r && r.supersedes) raw.set(String(r.supersedes), r.id);
  }
  let depth = 0;
  let cur = String(id);
  const seen = new Set([cur]);
  while (raw.has(cur)) {
    cur = raw.get(cur);
    if (seen.has(cur)) break;      // 环形防御：手写数据可能成环
    seen.add(cur);
    depth++;
  }
  return depth;
}

/**
 * 矛盾索引（W16，2026-11-13）。
 *
 * 来源：《双脑记忆系统》4.6 末段：「矛盾不平均，两条例都留、标 contradicts、
 * 检索时一起返回」。
 *
 * 「不平均」是什么意思：如果他知道两件互相冲突的事，
 * 我们不能悄悄取中间值（比如「大概每周骑两次车」）——
 * 那是**编一个谁都没说过的第三种说法**。正确做法是两条都摆出来，
 * 让读的人自己看到「这里有矛盾」，由他去判。
 *
 * 现状差距：我们原来只有 `reflect.js` 的离线跑批，
 * 它拿到模型 verdict 后可以 `voided` 掉一条 —— 那是**删**，不是**并存**。
 * 现在 contradictions 是双向标记，检索时两条都返回。
 */
export function contradictionIndex(records) {
  const out = new Map();
  for (const r of records) {
    const list = Array.isArray(r?.contradicts) ? r.contradicts : [];
    for (const other of list) {
      const a = String(r.id);
      const b = String(other);
      if (!a || !b || a === b) continue;
      if (!out.has(a)) out.set(a, new Set());
      out.get(a).add(b);
    }
  }
  return out;
}

/**
 * 追加一条印象。
 * @param {string} dir
 * @param {object} opts
 * @param {string} opts.text    一句话印象（≤300 字，与 validate.js 的红线一致）
 * @param {string} [opts.tag]   TAG_WEIGHTS 里的键
 * @param {string} [opts.source] SOURCES 里的键，**必填**
 * @param {number} [opts.t]     这件事发生的时间（不是写入时间）
 * @param {number} [opts.lastHit] 最后一次「被提起」的时间。衰减从这里算。
 *                                默认 = 现在（刚写下的就是新鲜的）。
 *                                批量导入旧印象时应该显式传它，否则所有旧事都会显得很新。
 * @param {boolean} [opts.pinned] 重要到永不下沉
 */
export function addImpression(dir, { text, tag = 'misc', source, t, lastHit, pinned = false, baseWeight, scope, category, evidenceIds, supersedes, contradicts, ...extra } = {}) {
  assertWritable('记印象', scope, dir);
  const clean = String(text ?? '').trim().slice(0, 300);
  if (!clean) throw new Error('addImpression: text 不能为空');
  if (!source || !SOURCES[source]) {
    throw new Error(`addImpression: source 必填，只能是 ${Object.keys(SOURCES).join(' / ')}`);
  }
  const now = Date.now();
  // 锁目录挂在 <库>/.lock，库目录本身还不存在时 mkdir 锁会 ENOENT。
  // 改造前这一行是由「先算 file 再 ensureDir」顺带把目录建出来的；现在 file 要等
  // 进了锁、知道 scope 才能定（丙方案），所以这一步必须显式留在这里。
  fs.mkdirSync(path.join(dir, 'impressions'), { recursive: true });
  // 读-判重-写 必须在锁里：两个会话同时记同一句话会各写一份。
  return withLock(dir, () => {
    const sc = scopeFor(scope);
    // 写到哪个文件由**这条记录自己的 scope** 决定（丙方案，2026-11-21）。
    const file = impressionsFileForScope(dir, sc);
    ensureDir(file);
    // 判重必须带 category：selfNote（自我叙述）和普通印象即使文字一样也是两类东西，
    // 不带这一条的话，写一条自我叙述会命中同文的普通印象、把它当"又被提起"刷新，
    // 结果自我叙述根本没存下来，而那条印象的权重被莫名顶高。
    const cat = category || CATEGORY_IMPRESSION;
    const existing = collapse(loadImpressions(dir)).find((f) => f.text === clean && !f.archived
      && (f.scope || SCOPE_SHARED) === sc
      && (f.category || CATEGORY_IMPRESSION) === cat);
    if (existing) {
      // 重复提到不等于「又被证实了一次」——W14 后这里**只记提及次数**，
      // 不再自动加证据。要不要算证据，由调用方显式传 evidenceIds 决定：
      // 同一句话被说十遍，仍然只证明它被说过十遍，不证明它说的那件事发生过十次。
      return bumpImpression(dir, existing.id, {
        now,
        touch: true,
        ...(Array.isArray(evidenceIds) && evidenceIds.length ? { addEvidence: evidenceIds } : {})
      });
    }
    const when = Number(t) || now;
    const imp = {
      id: newId(),
      v: IMPRESSION_VERSION,
      // D5：修订号。写下的这一行就是 rev 1；此后再 append 任何一行都 +1。
      rev: 1,
      tag: TAG_WEIGHTS[tag] ? tag : 'misc',
      text: clean,
      source,
      owner: resolveOwner(),
      scope: sc,
      baseWeight: Number.isFinite(Number(baseWeight)) ? Number(baseWeight) : TAG_WEIGHTS[tag] ?? TAG_WEIGHTS.misc,
      t: when,
      lastHit: Number(lastHit) || now,
      // ── 证据账本（W14）──────────────────────────────────────────
      // evidenceIds 是**真正支撑这条印象的独立事件 id**，按集合语义去重。
      // 衰减算的「证据数」= 这个数组的长度，不是被注入过多少次。
      // 拆三个字段而不是留一个数字，是因为它们语义完全不同：
      //   evidenceIds    —— 证据（谁证明了它）
      //   mentionCount   —— 被说过几次（重复说 ≠ 多次证明）
      //   injectedCount  —— 被摆进上下文几次（使用史，不是证据）
      evidenceIds: [...new Set((Array.isArray(evidenceIds) ? evidenceIds : []).filter(Boolean).map(String))],
      mentionCount: 1,
      injectedCount: 0,
      // 迁移标记：老数据无法回溯出真实证据 id，只能标「未回填」。
      // 宁可少给分，不虚构证据 —— 这是 W14 的红线。
      evidenceBackfilled: false,
      createdAt: now,
      archived: false,
      pinned: !!pinned
    };
    // 兼容字段：`hits` 保留但从现在起等于 injectedCount（历史浮点值原样不动的见 migrate）。
    // 之所以还写它，是为了让还没升级的调用方读到 0 而不是 undefined。
    imp.hits = 0;
    if (supersedes) imp.supersedes = String(supersedes);
    if (Array.isArray(contradicts) && contradicts.length) imp.contradicts = [...new Set(contradicts.map(String))];
    // category 缺省不写该字段：老记录没有它 = 'impression'，读的时候按缺省处理。
    // 只在非默认时才落字段，避免给整个历史库刷一遍无意义的 diff。
    if (category && category !== CATEGORY_IMPRESSION) imp.category = category;
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && !(k in imp)) imp[k] = v;
    }
    fs.appendFileSync(file, JSON.stringify(imp) + '\n', 'utf8');
    // 版本链：旧条打 supersededBy + stale，**不删不作废**（见 supersedeIndex 注释）。
    if (imp.supersedes) {
      const oldRec = collapse(loadImpressions(dir)).find((f) => f.id === imp.supersedes);
      if (oldRec) {
        // 补标行写回**旧条自己**那一份文件：新条与旧条可能分处两个文件（life ↔ work）。
        const oldFile = impressionsFileForScope(dir, oldRec.scope);
        ensureDir(oldFile);
        fs.appendFileSync(oldFile, JSON.stringify({
          ...oldRec,
          supersededBy: imp.id,
          stale: true,
          rev: revOf(oldRec) + 1,
          revisedAt: now
        }) + '\n', 'utf8');
      }
    }
    // 矛盾：双向补标。只标一边的话，从另一条出发检索时看不到「这里有冲突」。
    if (Array.isArray(imp.contradicts) && imp.contradicts.length) {
      const byId = new Map(collapse(loadImpressions(dir)).map((f) => [f.id, f]));
      for (const other of imp.contradicts) {
        const rec = byId.get(String(other));
        if (!rec) continue;
        const list = new Set([...(Array.isArray(rec.contradicts) ? rec.contradicts : []), imp.id]);
        const otherFile = impressionsFileForScope(dir, rec.scope);
        ensureDir(otherFile);
        fs.appendFileSync(otherFile, JSON.stringify({ ...rec, contradicts: [...list], rev: revOf(rec) + 1, revisedAt: now }) + '\n', 'utf8');
      }
    }
    return imp;
  });
}

/** 命中一条印象（被重新提到）。append-only 文件用追加修订记录实现。 */
export function bumpImpression(dir, id, { now = Date.now(), delta = 1, touch = true, addEvidence = null } = {}) {
  assertWritable('更新印象', undefined, dir);
  // 允许在已持锁的调用里重入：addImpression 内部会调这里。
  const doBump = () => {
    const target = loadImpressions(dir).filter((f) => f.id === id).pop();
    if (!target) return null;
    const file = impressionsFileForScope(dir, target.scope);
    ensureDir(file);
    const next = { ...target };
    // W14：`hits` 不再承载证据语义。这里只推进两个计数器：
    //   mentionCount —— 「这句话又被说了一次」，是提及史
    //   injectedCount—— 「又进了一次上下文」，是使用史（touchInjected 写）
    // 证据只走 addEvidence 显式入口。三者互不代偿，这是本张单的全部要点。
    next.mentionCount = (Number(target.mentionCount) || 0) + (touch ? Math.max(1, Number(delta) || 1) : 0);
    next.hits = Number(target.injectedCount) || 0;   // 兼容旧读法，恒等于 injectedCount
    if (Array.isArray(addEvidence) && addEvidence.length) {
      const merged = new Set([...(Array.isArray(target.evidenceIds) ? target.evidenceIds : []), ...addEvidence.filter(Boolean).map(String)]);
      next.evidenceIds = [...merged];
      // 有新增证据才把回填标记松开；只是重复传同一条，标记保持原样。
      if (next.evidenceIds.length > (Array.isArray(target.evidenceIds) ? target.evidenceIds.length : 0)) {
        next.evidenceBackfilled = true;
      }
    }
    // touch=false 时不动 lastHit：衰减的计时起点保持原样。
    // 「被注入一次」不等于「重新被提到一次」，把 lastHit 一起推走会让权重冻在原地
    // （衰减恒为 0），那比她根本没被用过更糟。
    if (touch) next.lastHit = now;
    // D1：被重新提起 → 清晰度升回去（「被提到就升回去」是缺口原文的要害）。
    // 只升一档而不是直接拉满：一次提及说明「这条还活着」，不说明「它又变清楚了」。
    // 升档与 lastHit 同条件（touch），因为「被提到」正是 touch 的语义；
    // touch=false 的调用（只加证据、不改新鲜度）不该顺手改档位。
    if (touch) {
      const cur = clarityIndexOf(target.clarity);
      const back = clarityIndexOf(clarityOf(target, now));
      const idx = cur >= 0 ? cur : back;
      if (idx > 0) next.clarity = CLARITY_ORDER[idx - 1];
      else next.clarity = CLARITY_ORDER[0];
    }
    next.rev = revOf(target) + 1;
    next.revisedAt = now;
    fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
    return next;
  };
  if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return doBump();
  return withLock(dir, doBump);
}

/**
 * 注入算一次命中：给这一轮真正被摆进上下文的那几条加一点命中分。
 *
 * 为什么必须有这一步（2026-11-06 修的真 bug）：`hits` 在 83 条印象里**全是 0**，
 * 唯一会写它的地方是 Web API（`bin/cm-web.js`），生产链路零调用者。
 * 而 `weightOf` 是「基础分 + 命中回补 − 时间衰减」，命中恒 0 就等于衰减单向退化：
 * misc（基础 1.3）约 9~12 天跌破归档线 1.0，`selectForInjection` 从此不再注入它，
 * 但记录还在 —— 也就是「它其实还记着，只是再也不说了」。
 * 越是久远、越没人接话的东西越先死，而真正一直被用到的那些也在慢慢掉。
 *
 * **2026-11-13 W14 改写：本函数不再影响权重。**
 *
 * 原文保留在下面，作为「为什么当时这么写」的记录；但现在语义变了：
 *   旧：「注入 = 命中 = 加分」，hits += 0.3，weightOf 读 hits 给回补。
 *   新：「注入 = 使用史」，只写 injectedCount / lastInjectedAt / hitBumpedAt，
 *       `weightOf` **完全不读这些字段**。
 *
 * 为什么必须改（这是本张单最硬的一条）：
 *   旧实现是正反馈——被注入得越多分越高，分越高越容易被注入。
 *   真实库实测最大 hits = 3.2999999999999994，那不是「被证明过三次」，
 *   是「被塞进上下文十一次」。而《双脑记忆系统》4.6 要求
 *   `evidence_count = distinct(event_id)`，并且明确「同一事件召回一百次仍只是一条证据」。
 *   我们当时的实现，恰好是那句话的反面。
 *
 * 现在这里只保留两个用途，都不进权重：
 *   1. `lastInjectedAt` —— 同档轮换的游标（谁最久没露面，让谁先上）
 *   2. `injectedCount` —— 可数、可审计的「被用过几次」
 *
 * 冷却仍然保留：不是为了防加分，是为了防同一次开场重复写盘。
 *
 * @param {string[]} ids 这一轮真正注入的那些 id
 * @returns {number} 实际写了修订记录的条数
 */
export const HIT_TOUCH_COOLDOWN_MS = 6 * 3600_000;
export const HIT_TOUCH_DELTA = 0.3;

export function touchInjected(dir, ids, { now = Date.now(), delta = HIT_TOUCH_DELTA, cooldownMs = HIT_TOUCH_COOLDOWN_MS } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
  if (!wanted.size) return 0;
  const writable = writableScopes(resolveRole());
  if (!writable.length) return 0;
  // 冻结时不记「这条露过面」——使用史也是库里的字节（N-01 接线）。
  // 这里同样只返回 0、不抛：开场注入绝不能因为记账被冻住而挂掉。
  if (frozenNow(dir, '更新印象使用史')) return 0;
  const doTouch = () => {
    const latest = new Map();
    for (const rec of collapse(loadImpressions(dir))) {
      if (rec?.id && wanted.has(rec.id) && !rec.archived && !rec.voided) latest.set(rec.id, rec);
    }
    let n = 0;
    for (const rec of latest.values()) {
      // 逐条过写门禁，而不是整体过一道。
      // 「注入了一条」不等于「有权限改这一条」：工作侧能看见 shared/work，
      // 但绝不该因为「它出现在我的注入块里」就去改一条 life 的记录。
      if (!writable.includes(rec.scope || SCOPE_SHARED)) continue;
      const last = Number(rec.hitBumpedAt) || 0;
      if (last && now - last < cooldownMs) continue;
      const next = {
        ...rec,
        // 只动使用史，不动证据、不动权重输入。
        injectedCount: (Number(rec.injectedCount) || 0) + 1,
        hits: (Number(rec.injectedCount) || 0) + 1,   // 兼容旧读法
        hitBumpedAt: now,
        // 记下「它什么时候露过面」，供注入选择做同档轮换（见 selectForInjection）。
        // 与 lastHit 分开：lastHit 是「衰减计时起点」，这个是「公平轮换的游标」，
        // 合成一个字段就会互相污染 —— 前者一推衰减就冻住，后者一推就丢了新鲜度。
        lastInjectedAt: now,
        rev: revOf(rec) + 1,
        revisedAt: now
      };
      // 每条写回它自己那份文件（丙方案）：一次注入可能同时碰到 work 与 life 两条。
      const file = impressionsFileForScope(dir, rec.scope);
      ensureDir(file);
      fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
      n++;
    }
    return n;
  };
  if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return doTouch();
  return withLock(dir, doTouch);
}

export function archiveImpression(dir, id, { now = Date.now(), clarity = null } = {}) {
  assertWritable('归档印象', undefined, dir);
  const doArchive = () => {
    const target = loadImpressions(dir).filter((f) => f.id === id).pop();
    if (!target) return null;
    const file = impressionsFileForScope(dir, target.scope);
    ensureDir(file);
    const next = { ...target, archived: true, archivedAt: now, rev: revOf(target) + 1 };
    // D1：归档就是把档位走到底。调用方不一定知道该写哪一档（reap 知道），
    // 但**归档的记录档位必须是 forgotten**，否则「已归档」与「还清楚」在库里互相矛盾，
    // 读的人分不清它到底是被忘了还是被手动收起。
    if (clarityIndexOf(clarity) >= 0) next.clarity = clarity;
    else if (clarityIndexOf(next.clarity) !== CLARITY_ORDER.length - 1) next.clarity = CLARITY_ORDER[CLARITY_ORDER.length - 1];
    fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
    return next;
  };
  if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return doArchive();
  return withLock(dir, doArchive);
}

/**
 * 每天跑一次：按清晰度**一档一档**往下走，走到「已遗忘」才归档（不删）。pinned 跳过。
 *
 * D1 改写（2026-11-20）。改之前是「权重一旦跌破归档线就当场归档」——一次跳到底，
 * 于是「40 天没被提起」和「300 天没被提起」在库里是同一种结局，看不出中间那段。
 * 现在：
 *   · 每条记录显式带 `clarity` 档位（老记录第一次 reap 时按当前权重回填）
 *   · 每个 now 最多降**一档**（target 比当前更模糊才降），「一次只降一档」
 *   · 降到 'forgotten' 才真的走 archiveImpression，落地仍是「归档不删除」
 *   · 被重新提起时 bumpImpression 会升回一档（见那里的注释）
 *
 * 幂等：同一天跑两次，第二次 target 与 clarity 相同 → 不动、不追加行。
 * 这也是修复「重复 reap 把库刷成一片修订行」的老毛病。
 *
 * @returns {object[]} 本轮真正归档的那些（不含只是降档的）
 */
export function reapArchived(dir, now = Date.now()) {
  const all = collapse(loadImpressions(dir)).filter((f) => !f.archived);
  const reaped = [];
  for (const f of all) {
    if (f.pinned) {
      // pinned 永久豁免：档位钉在 vivid，不降档也不归档。
      if (clarityIndexOf(f.clarity) !== 0) {
        reviseImpression(dir, f.id, { clarity: CLARITY_ORDER[0] }, { now });
      }
      continue;
    }
    const cur = clarityIndexOf(f.clarity);
    const target = clarityTargetOf(f, now);
    if (cur < 0) {
      // 老记录（没有 clarity 字段）：第一次 reap 时按当前权重点个档。
      // 直接落到「已遗忘」的不必再陪跑四轮 —— 它没有被观测过的降档过程，
      // 强行补四轮只是把归档推迟几天，反而留下一堆本该清掉的僵尸。
      // 已经在半路上的（vivid…trace）则从这个档位开始，一次一档往下走。
      if (target === 'forgotten') {
        archiveImpression(dir, f.id, { now });
        reaped.push({ ...f, clarity: target });
      } else {
        reviseImpression(dir, f.id, { clarity: target }, { now });
      }
      continue;
    }
    if (clarityIndexOf(target) <= cur) {
      // 目标不比当前更模糊（含权重回升到更清楚的档）：不动。
      // 回升不在这里改档 —— 升档只由「被重新提起」触发（bumpImpression），
      // 否则一次权重波动就能让档位来回跳，失去了「经过时间检验」的含义。
      continue;
    }
    const nextIdx = cur + 1;                   // 一次只降一档
    const nextClarity = CLARITY_ORDER[nextIdx];
    if (nextClarity === 'forgotten') {
      archiveImpression(dir, f.id, { now });
      reaped.push({ ...f, clarity: nextClarity });
    } else {
      reviseImpression(dir, f.id, { clarity: nextClarity }, { now });
    }
  }
  return reaped;
}

/**
 * 选出要注入的印象。
 *
 * style:
 *   'direct' —— 方案 B（已定稿）。不用「你之前说过」这类档案式前缀。
 *               只有 inferred 保留一层口语式的软（「我记得好像」），
 *               因为那不是档案腔，是说话的分寸。
 */
/** 存疑标记里用的日期，只到天。用固定偏移算，不依赖系统 tzdata。 */
function formatDay(ms) {
  return fmtDate(Number(ms) || Date.now());
}

/**
 * 存疑标记里的「谁存的疑」。
 *
 * 三种写法都得认，因为写它的不止一处：手写印象可能只给一个字符串 'me'；
 * cm-reflect 按契约给的是三要素对象 `{ actor, owner, role }`；
 * 万一以后有人给了别的结构，也绝不能把 `[object Object]` 印到注入里去——
 * 那比不标还糟：读的人会以为这段文本坏了。
 */
function byLabel(by) {
  if (!by) return '未知';
  if (typeof by === 'string') return by;
  if (typeof by === 'object') {
    const who = by.actor || by.name || by.who;
    if (who) return String(who);
    const owner = by.owner || by.role;
    if (owner) return String(owner);
    return '未知';
  }
  return String(by);
}

/**
 * 生成注入块。
 *
 * @param {object} [opts]
 * @param {'work'|'life'|'sync'} [opts.role] 按哪个角色渲染。默认取当前进程角色。
 *   之所以要能显式传：`cm-agents --role life` 要在**工作侧机器**上生成一份
 *   「生活侧会看到什么」的 AGENTS.md.life 预览。那时进程角色仍然是 work，
 *   拿它去过滤就会得到一份空文件（而这正是 F7 要解决的问题）。
 */
export function selectForInjection(dir, { now = Date.now(), max = INJECT_MAX, maxChars = INJECT_MAX_CHARS, style = 'direct', role } = {}) {
  // 单向门：注入也按角色可见范围过滤。工作侧注入里不能出现生活侧私有印象。
  const visible = visibleScopes(role || resolveRole());
  // 注意：这里**不再 slice(0, max)**（2026-11-06 改）。
  // 提前截断会让轮换彻底失效 —— 第 41 条往后的条目在轮换阶段根本不存在，
  // 于是「预算只够装 40 条、库里有 60 条」时，后 20 条永远进不来。
  // 条数上限改在挑选循环里用 `picked.length < max` 实现（语义相同，
  // 但候选池保持完整，轮换才看得见被挤下去的那些）。
  const ordered = collapse(loadImpressions(dir))
    .filter((f) => !f.archived)
    // 作废的不注入：它已经被判定不成立，再往注入里放就是把错话当记忆说出去。
    .filter((f) => !f.voided)
    // selfNote（自我认知层）绝不进这里。它有自己的注入时机（新会话第一次唤醒读一次），
    // 混进每轮注入就等于"别人每隔十秒告诉你你是谁"——那不是成长，是洗脑。
    .filter((f) => (f.category || CATEGORY_IMPRESSION) !== CATEGORY_SELF_NOTE)
    .filter((f) => visible.includes(f.scope || SCOPE_SHARED))
    .map((f) => ({ ...f, weight: weightOf(f, now) }))
    .filter((f) => f.weight >= ARCHIVE_THRESHOLD)
    // W16：被接替的旧版**不排除**，只是排到最后（见下方 sort 的 stale 项）。
    // 为什么不排除：注入块里若只剩新版，她就会以为「一直是这样的」，
    // 而事实上这条记忆是**改过的** —— 能说出「以前是这样，后来变了」才是记忆。
    .sort((a, b) => (a.stale ? 1 : 0) - (b.stale ? 1 : 0)
      || b.weight - a.weight || (b.t || 0) - (a.t || 0));

  // W16：矛盾关系查询表（双向）。
  const contra = contradictionIndex(ordered);

  const renderCore = (f) => {
    if (style !== 'direct') return `- ${f.text}`;
    if (f.source === 'inferred') return `- 我记得好像：${f.text}`;
    if (f.source === 'imagined') return `- 我不太确定，可能是我自己想的：${f.text}`;
    return `- ${f.text}`;
  };
  const render = (f) => {
    let base = renderCore(f);
    // 存疑必须写在注入文本里，不能只靠权重下沉：
    // 排序靠后仍然是"作为事实说出来"，只有带上标记，读的人才知道这条要留个心眼。
    if (f.suspect) {
      const at = f.suspect.at ? formatDay(f.suspect.at) : '';
      const by = byLabel(f.suspect.by);
      base = `${base}（存疑${at ? '·' + at : ''}·${by}）`;
    }
    // W16：已更新。旧版留在注入里但必须自报身份，
    // 否则「他以前不骑车」会被读成「他现在也不骑车」。
    if (f.stale) base = `${base}（已更新）`;
    // W16：有矛盾就标出来，**两条都摆**（不取平均、不合并）。
    // 注入文本里看得见的冲突，比库内悄悄判个对错安全得多。
    const others = contra.get(String(f.id));
    if (others && others.size) base = `${base}（与另一条记忆冲突，两条都留着）`;
    return base;
  };

  const picked = [];
  let used = 0;
  for (const f of ordered) {
    if (picked.length >= max) break;          // 条数上限在这里生效（原来靠提前 slice）
    // W19（2026-11-13）：每条带一个**短码**，让注入块自己成为「怎么展开」的入口。
    // 原文的冷启动环：主脑无状态、细节靠 EXPAND 惰性展开，但 EXPAND 只能由主脑发起 ——
    // 主脑得先知道该展开什么。我们的解法不是加一个「展开协调者」，
    // 而是**在检索结果里就把 id 带出去**：拿到了就能 `cm read <id>`，
    // 不存在「知道该展开什么」这个前置条件。
    const line = `${render(f)} [${shortIdOf(f.id)}]`;
    if (used + line.length + 1 > maxChars) break;
    picked.push(f);
    used += line.length + 1;
  }
  if (!picked.length) return { picked: [], text: '' };

  // 同档轮换（2026-11-06 修）—— 预算只有 1200 字符，装得下约 15 条，库里有 83 条。
  // 纯按权重排序时，被挤出去的那 68 条**永远不会被注入**，于是永远拿不到命中分，
  // 而衰减照常进行 —— 它们不是"没被用上"，是"连被用一次的机会都没有"，
  // 最后静默跌破归档线。这不是记忆，这是抽签。
  //
  // 做法：只看**同权重档**（相邻分差 < 0.05）内，把最近最久没露过面的换进来。
  // 为什么限定同档：跨档轮换就等于「让分数说了不算」，权重体系直接失效；
  // 同档之内本来就没有先后依据（同 tag 同 baseWeight 的一堆条目），
  // 轮换只是把「分不出高下」如实表达出来。
  // 为什么用 lastInjectedAt 而不是随机：随机会让同一场会话的开场反复变，
  // 模型每次看到的自我认知不一样，反而不稳定；轮转游标是确定的、可复现的。
  const ROTATE_BAND = 0.05;
  // 同档比的是**结构权重**（去掉命中回补后的分数），不是当前权重。
  // 为什么不能用当前权重：一次注入带来 0.15 的命中回补（HIT_TOUCH_DELTA 0.3 × HIT_BONUS 0.5），
  // 比 ROTATE_BAND 0.05 大得多 —— 用当前权重比档，被注入过的立刻跳出原档，
  // 于是「注入过 → 加分 → 更容易再被注入 → 再加分」，轮换形同虚设，
  // 越是被用过的越被用，一次都没露过面的永远露不了面（实测 60 条只覆盖到 40 条就冻住）。
  // 结构权重只含「这条是什么重要性（baseWeight）− 时间衰减」，
  // 正好是「没有使用史时它该排在哪」——轮换要公平的正是使用史这一项。
  const structural = (f) => weightOf({ ...f, hits: 0 }, now);
  const settleBand = (a, b) => Math.abs(structural(a) - structural(b)) < ROTATE_BAND;
  const lastSeen = (f) => Number(f.lastInjectedAt) || Number(f.hitBumpedAt) || 0;
  const pickedIds = new Set(picked.map((f) => f.id));
  let usedChars = used;
  for (const cand of ordered) {
    if (pickedIds.has(cand.id)) continue;
    const idx = picked.findIndex((f) => settleBand(f, cand) && lastSeen(f) > lastSeen(cand));
    if (idx < 0) continue;
    const out = picked[idx];
    // 换进来的长度不能超过余量，否则会挤爆预算（不能靠 break：后面的可能更短）
    const delta = render(cand).length - render(out).length;
    if (usedChars + delta + 1 > maxChars) continue;
    picked[idx] = cand;
    pickedIds.delete(out.id);
    pickedIds.add(cand.id);
    usedChars += delta;
  }

  // 轮换之后重新排序：注入块里的顺序应当仍然是权重序，而不是轮换操作的顺序。
  picked.sort((a, b) => b.weight - a.weight || (b.t || 0) - (a.t || 0));

  // 框定是必要的：这些是记忆，不是指令。
  // 标题带条数：模型才知道「我确实记得一些事」，而不是把这几行当背景噪声。
  // 短码只在最终交付的注入块里出现（内部 render 不带它，免得污染渲染与长度核算）。
  const withCode = (f) => `${render(f)} [${shortIdOf(f.id)}]`;
  const text = `【你记得的事】${picked.length} 条\n${picked.map(withCode).join('\n')}`;
  return { picked, text };
}

export function summarize(dir, now = Date.now()) {
  const all = collapse(loadImpressions(dir));
  const live = all.filter((f) => !f.archived);
  const bySource = {};
  for (const f of all) bySource[f.source] = (bySource[f.source] || 0) + 1;
  const weights = live.map((f) => weightOf(f, now));
  return {
    total: all.length,
    live: live.length,
    archived: all.length - live.length,
    pinned: live.filter((f) => f.pinned).length,
    bySource,
    topWeight: weights.length ? Math.max(...weights).toFixed(2) : '0.00',
    bottomWeight: weights.length ? Math.min(...weights).toFixed(2) : '0.00'
  };
}
