// cm-reflect：自主反思循环。
//
// 干什么：定期把「记着的印象」拿去和更新的原文对一遍，判三档：
//   still-true（还成立，不动）/ suspect（存疑，带三要素）/ void（作废，终态）。
//
// 三条不可退让的底线（改这个文件之前先读这三条）：
//   1. **只做减法**：本模块只标存疑/作废/撤疑，绝不新增印象。加法由人/主对话决定，
//      否则「成长」会变成模型自己编自己。
//   2. **失败不写**：外发失败（超时/非 200/坏 JSON）→ 记忆文件一个字节都不动，
//      只写审计日志和失败计数（失败计数在 reflect-state.json，不是记忆内容）。
//   3. **门禁不绕**：每次落盘前都过 assertWritable(scope)。被拒就丢掉那一条，
//      不许因为「这是自我反思」破例——自我叙述不是越权的理由。
//
// 与 impressions.js 的分工：那边管「记什么」，这边管「还对不对」。
// 本模块的写入全部走 append-only 修订记录（新记录 = {...首条, ...patch}），
// text/source/scope/owner 逐字节不变，原意一个字都不改。

import fs from 'node:fs';
import path from 'node:path';
import {
  withLock, resolveOwner, resolveRole, LOCK_DIRNAME, assertWritable,
  visibleScopes, fileStamp, hashOf, SCOPE_SHARED
} from './shared.js';
import { loadImpressions, collapse, impressionsFileForScope, weightOf } from './impressions.js';
import { makeId } from './store.js';
import { eventsDirOf, lifeEventsDirOf } from './paths.js';
import { frozenNow } from './freeze-guard.mjs';
import { coldShardMonths, coldRecordsOfShard, coldStamp, shardOverlaps } from './cold-archive.js';
import { findKey } from './embed.js';
import { fmtDate, fmtLocalMinute } from './localtime.js';

export const REFLECT_VERSION = 1;
export const REFLECT_DEFAULTS = {
  maxCandidates: 3,
  maxSuspectsPerRound: 2,
  maxVoidsPerRound: 1,
  intervalMs: 600_000,
  minIntervalMs: 60_000,
  backoffSec: [300, 900, 1800, 3600],
  hourCap: 6,
  timeoutMs: 8_000,
  cooldownMs: 21_600_000,
  maxPerItem: 3,
  maxPayloadChars: 6_000,
  /**
   * 字节上限（与外发字面预算并行卡）。中文二字一…不，中文一字三字节，
   * 所以 6000 字的中文正文实际是 18000 字节级别。给 2 倍宽 =
   * 「中文按 6000 字卡、英文按 12000 字节卡」，两边都不至于白砍。
   */
  maxPayloadBytes: 12_000,
  evidenceQuoteChars: 400,
  /**
   * 反思进程单例租约的「心跳过期」阈值 = `intervalMs * singletonStaleMultiplier`。
   *
   * ⚠️ 这个数有两条硬约束，而且**必须跟着间隔走**，不能写死一个绝对值：
   *   ① 必须 **> 一个心跳周期**（`cm-reflect` 每轮起止各 beat 一次，
   *      心跳间隔就等于 `intervalMs`）——否则正常等下一轮会被误判成死，
   *      两个 reflect 一起跑 → 同一轮候选被应用两遍。
   *   ② 必须 **< guard 的重启窗口**（否则 guard 拉起的新进程全都因租约未过期
   *      exit 3 → 拉起/退出死循环）。`guard.ps1:193`
   *      `$reflectStaleSec = $ReflectSec * 3 + 60`，而 guard 用 `--interval 120` 启动
   *      （`$ReflectSec = 120`）→ 窗口 = **420s**，故 120 * 3 = **360s** 正好落在 (120, 420)。
   *
   * 为什么不能写死 360s：裸调用不带 `--interval` 时默认 `intervalMs = 600_000`，
   * 写死 360s 反而 < 600s 的心跳 → 第二个裸 cm-reflect 在 360s 后抢到租约（双跑）。
   * 乘 3 的写法两边都自洽：guard 场景 360s ✓、裸调 1800s > 600s ✓。
   *
   * 旧值 `Math.max(1800_000, intervalMs * 3)` 的问题是那个 1800s **下限**：
   * guard 场景下把阈值顶到 1800s，比 420s 窗口长 4.3 倍 —— 这正是
   * 2026-11-06「日志刷 4 万字节、一轮反思都没跑成」的根因。下限去掉即可。
   *
   * 用例：`tests/cases/singleton.mjs` 的「reflect 租约阈值落在 (心跳周期, guard 窗口) 之间」。
   */
  singletonStaleMultiplier: 3
};

/** 存疑/作废的理由分类（写死在实现里，不给 LLM 自由裁量）。 */
export const BECAUSE_KINDS = ['contradicted', 'expired', 'duplicated', 'unverifiable', 'low-evidence'];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const REFRESH_WINDOW_MS = 7 * DAY_MS;
const HANDLED_MAX = 200;
/** 作废前必须等的确认窗口：存疑满这么久，下一轮再判冲突才允许升级。 */
const VOID_WAIT_MS = DAY_MS;
const AUDIT_FILE = 'reflect-audit.jsonl';
const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

/** 否定/收回句的记号。只用来「判存疑」，不用来自动作废。 */
const NEGATION_RE = /不用|不需要|不要|取消|算了|不是这样|不是这个|没这事|没有这事|改成|先不|别再|不搞|不做了|拉倒/;
/**
 * 第三方隐私：命中就不外发这条证据。
 * 与 src/validate.js 里那条同源（那边没单独 export，这里保持同一份规则）。
 */
const PRIVACY_RE = /(他说|她说|他妈|他家和|她家)[^，。]{0,10}(隐私|秘密|病|离婚|出轨|住院|ICU|死)/;

// ---------------------------------------------------------------- 小工具

const countChars = (s) => [...String(s ?? '')].length;

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function stampOf(dateFormat, ms, style = 'datetime') {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  if (typeof dateFormat === 'function') return String(dateFormat(t) ?? '');
  if (style === 'day' || dateFormat === 'day') return fmtDate(t);
  return fmtLocalMinute(t);
}

function hourStartOf(now) {
  return Math.floor(Number(now) / HOUR_MS) * HOUR_MS;
}

function sourceLabel(src) {
  return { user_said: '他说', inferred: '我推的', imagined: '我猜的', told: '别人说的' }[src] || String(src || '来源不明');
}

function scopeLabel(scope) {
  return { shared: '共享', work: '工作侧', life: '生活侧' }[scope || SCOPE_SHARED] || String(scope || '共享');
}

/** 中文两字一组 + 单字兜底。够用来做「这段原文和这条印象是否在说同一件事」。 */
function grams(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  if (!s) return out;
  if ([...s].length < 2) { out.add(s); return out; }
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n;
}

function noteOf(why, max = 200) {
  return String(why ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function appendLines(file, records) {
  ensureDir(file);
  // 单次 append：设计上要「一次 write 系统调用」，半行风险最小。
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// 丙方案（2026-11-21）：原文按 scope 分两个目录，life 那份在本机专属目录里。
// 反思必须两边都看 —— 只反思工作侧那一半，等于放弃对生活层的自我校正。
// 读序：life 目录在前、主目录在后（life→work 的改判行落在主目录，后读才能覆盖）。
function rawEventDirs(dir) {
  return [lifeEventsDirOf(dir), eventsDirOf(dir)];
}

function readRawWindow(dir, { from = 0, to = Date.now(), visible = visibleScopes() } = {}) {
  const eventsDir = eventsDirOf(dir);
  let shards = [];
  // 两个目录各扫一遍，收成 [{dir, shard}]
  const hotFiles = [];
  for (const d of rawEventDirs(dir)) {
    let names = [];
    try {
      names = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'));
    } catch { /* 目录不在也可以只有冷归档，下面照读 */ }
    for (const n of names) hotFiles.push({ dir: d, file: path.join(d, n) });
  }
  shards = hotFiles.map((h) => h.file);
  const out = [];
  const lineFilter = (rec) => {
    const t = Number(rec.t);
    if (!Number.isFinite(t) || t < from || t > to) return false;
    const sc = rec.scope || SCOPE_SHARED;
    // 单向门：外发/证据收集也只能碰当前角色看得见的层。
    if (!visible.includes(sc)) return false;
    out.push(rec);
    return true;
  };
  // 冷归档（2026-11-13）：印象层要拿来对「还成不成立」的原文，可能早被压走了。
  // 只读热分片会让反思窗口在月度边界之外突然缩水成空的。
  // 月份边界先判，不相交的月份不解压。
  let coldMonths = [];
  try { coldMonths = coldShardMonths(dir); } catch { coldMonths = []; }
  for (const shard of coldMonths) {
    if (!shardOverlaps(shard, from, to)) continue;
    let recs = [];
    try { recs = coldRecordsOfShard(dir, shard); } catch { recs = []; }
    for (const rec of recs) lineFilter(rec);
  }
  for (const file of shards) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      lineFilter(rec);
    }
  }
  out.sort((a, b) => (a.t || 0) - (b.t || 0));
  return out;
}

function rawStampOf(mem) {
  const dir = dirOf(mem);
  if (!dir) return ':missing';
  try {
    const eventsDir = eventsDirOf(dir);
    const lifeDir = lifeEventsDirOf(dir);
    const shards = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl')).sort();
    let lifeShards = [];
    try { lifeShards = fs.readdirSync(lifeDir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { lifeShards = []; }
    // 丙方案（2026-11-21）：life 那份原文也在本机，写了同样要换幂等键，
    // 否则「只有生活侧在写」的那些时段，反思会拿旧 stamp 认为什么都没变而跳过。
    const lifeStampPart = lifeShards.length
      ? fileStamp(path.join(lifeDir, lifeShards[lifeShards.length - 1]))
      : '';
    // 冷归档也参与指纹：归档动作本身让「原文窗口」变了，反思的幂等键必须跟着变，
    // 否则归档后第一次反思会拿旧 stamp 认为「什么都没变」而跳过。
    const coldMonths = coldShardMonths(dir);
    if (!shards.length && !lifeShards.length && !coldMonths.length) return ':missing';
    const hotBase = shards.length ? fileStamp(path.join(eventsDir, shards[shards.length - 1])) : ':missing';
    // 没有 life 分片时 hot 与旧版逐字节相同（不引入多余尾巴），免得没写过 life 的库
    // 幂等键无端变化、被测试或审计当成异常。
    const hot = lifeStampPart ? `${hotBase}|${lifeStampPart}` : hotBase;
    // 没有冷归档时返回值与旧版逐字节相同（不引入 `|:none` 尾巴），
    // 免得「没归档的库」幂等键无端变化、被测试或审计当成异常。
    return coldMonths.length ? `${hot}|${coldStamp(dir)}` : hot;
  } catch { return ':missing'; }
}

function dirOf(mem) {
  if (!mem) return '';
  if (typeof mem === 'string') return mem;
  return mem.dir || mem.store?.root?.replace?.(/[\\/]raw$/, '') || '';
}

/** 库里所有「可以被 because.refs 指到」的 id：原文 id + 印象 id。 */
function existingIdSet(dir) {
  const set = new Set();
  for (const rec of loadImpressions(dir)) if (rec?.id) set.add(rec.id);
  // 丙方案（2026-11-21）：life 原文也在本机，because.refs 指到它同样有效。
  const hotFiles = [];
  for (const d of rawEventDirs(dir)) {
    try {
      for (const n of fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'))) hotFiles.push(path.join(d, n));
    } catch { /* 该目录还没有原文 */ }
  }
  const absorb = (rec) => {
    if (rec.id) set.add(String(rec.id));
    else if (rec.src || rec.seq) set.add(makeId({ src: rec.src, seq: rec.seq }));
  };
  // 已归档月份的 id 当然还能被 because.refs 指到 —— 历史没有因为压缩就作废。
  let coldMonths = [];
  try { coldMonths = coldShardMonths(dir); } catch { coldMonths = []; }
  for (const shard of coldMonths) {
    let recs = [];
    try { recs = coldRecordsOfShard(dir, shard); } catch { recs = []; }
    for (const rec of recs) absorb(rec);
  }
  for (const file of hotFiles) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      absorb(rec);
    }
  }
  return set;
}

function validateBecause(dir, because) {
  if (!because || typeof because !== 'object') return 'missing-because';
  const refs = Array.isArray(because.refs) ? because.refs.map((r) => String(r)) : [];
  if (!refs.length) return 'missing-refs';
  const ids = existingIdSet(dir);
  const missing = refs.filter((r) => !ids.has(r));
  if (missing.length) return 'invalid-evidence';
  return null;
}

function validateBy(by) {
  if (!by || typeof by !== 'object') return 'missing-by';
  if (!String(by.actor ?? '').trim()) return 'missing-by';
  return null;
}

/** 锁是否被别的会话占着（还是新鲜的）。真心跳 skip：不去排队 10 秒。 */
function lockBusy(dir, staleMs = 30_000) {
  const lockPath = path.join(dir, LOCK_DIRNAME);
  try {
    const st = fs.statSync(lockPath);
    return Date.now() - st.mtimeMs < staleMs;
  } catch { return false; }
}

/** 在锁内执行；调用方已持锁时直接跑（与 impressions.js 的重入约定一致）。 */
function withReprise(dir, fn) {
  if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return fn();
  return withLock(dir, fn);
}

// ---------------------------------------------------------------- 状态文件

export function reflectStateFileOf(dir) {
  return path.join(dir, 'reflect-state.json');
}

function defaultState(dir, now = Date.now()) {
  return {
    v: REFLECT_VERSION,
    dir: path.basename(String(dir ?? '')),
    lastRoundAt: 0,
    consecutiveFailures: 0,
    lastRoundId: null,
    lastPlanHash: null,
    hourBucket: { hourStart: hourStartOf(now), count: 0 },
    lastEvidenceStamp: null,
    handled: {},
    selfNote: {},
    handoff: {}
  };
}

/** 坏文件不抛：状态文件丢了只影响「本轮该不该跑」，不影响记忆本身。 */
export function loadReflectState(dir, now = Date.now()) {
  const base = defaultState(dir, now);
  let raw = '';
  try { raw = fs.readFileSync(reflectStateFileOf(dir), 'utf8'); } catch { return base; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return base; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return base;
  if (Number(obj.v) !== REFLECT_VERSION) return base;
  const state = { ...base, ...obj };
  state.hourBucket = { ...base.hourBucket, ...(obj.hourBucket && typeof obj.hourBucket === 'object' ? obj.hourBucket : {}) };
  state.handled = obj.handled && typeof obj.handled === 'object' && !Array.isArray(obj.handled) ? { ...obj.handled } : {};
  state.selfNote = obj.selfNote && typeof obj.selfNote === 'object' ? { ...obj.selfNote } : {};
  state.handoff = obj.handoff && typeof obj.handoff === 'object' ? { ...obj.handoff } : {};
  state.lastRoundAt = Number(state.lastRoundAt) || 0;
  state.consecutiveFailures = Math.max(0, Number(state.consecutiveFailures) || 0);
  state.hourBucket.count = Math.max(0, Number(state.hourBucket.count) || 0);
  state.hourBucket.hourStart = Number(state.hourBucket.hourStart) || 0;
  return state;
}

/**
 * 整体重写 + 原子替换。必须（也只在）锁内调用。
 *
 * `<dir>/reflect-state.json` 是**两个模块共用**的：reflect.js 自己的键（lastRoundAt /
 * consecutiveFailures / handled …）在这里，`selfNote` / `handoff` 是 handoff.js 的地盘。
 * 我们的 state 是「本轮到外发之前」读的，外发要等好几秒——这几秒里 handoff 完全可能
 * 刚写过 selfNote（比如 cm-boot 记录「本会话已注入」）。所以写之前必须在锁内**重读整份
 * 文件**，只覆盖自己的键；拿内存里的旧对象整体落盘会把别人的写入抹掉。
 */
export function saveReflectState(dir, state) {
  const file = reflectStateFileOf(dir);
  ensureDir(file);
  // 锁内重读（调用点都在 withLock 里面）；读不到/坏了就用传进来的那份。
  let disk = null;
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) disk = o;
  } catch { /* 没有或坏了：按传入的写 */ }
  const next = { ...state, v: REFLECT_VERSION, dir: path.basename(String(dir ?? '')) };
  if (disk) {
    // handoff 的键：磁盘上的更新，一律以磁盘为准（我们无权覆盖别人的写入）。
    if (disk.selfNote && typeof disk.selfNote === 'object') next.selfNote = disk.selfNote;
    if (disk.handoff && typeof disk.handoff === 'object') next.handoff = disk.handoff;
  }
  // handled 只留最近 200 条，否则这个文件会无限膨胀。
  const entries = Object.entries(next.handled || {})
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, HANDLED_MAX);
  next.handled = Object.fromEntries(entries);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

export function clearReflectState(dir) {
  try { fs.rmSync(reflectStateFileOf(dir), { force: true }); } catch { /* 没有就算了 */ }
}

// ---------------------------------------------------------------- 选目标（只读）

/**
 * 挑这一轮值得检查的印象。
 * 只读、无锁、不看网络。
 */
export function pendingCandidates(dir, { now = Date.now(), max, cooldownMs, role = null } = {}) {
  const cap = Number.isFinite(max) && max > 0 ? max : REFLECT_DEFAULTS.maxCandidates;
  const cd = Number.isFinite(cooldownMs) ? cooldownMs : REFLECT_DEFAULTS.cooldownMs;
  // 选人阶段就要按角色可见范围过滤（2026-11-06 修）。
  // 以前这里不看 scope，选出来的前 3 条可能全是 life 层的，到 applyPlan
  // 才被 assertWritable 拦下记 readonly-scope —— 选人与执行角色不一致，
  // 等于每轮注定空转。实测 74 轮里 63 次 readonly-scope 全是这么来的，
  // 而且刷出来的日志看起来像「模型想改但没权限」，掩盖了真正的原因：
  // 启动 cm-reflect 的 guard.ps1 根本没带 CM_ROLE。
  // 现在两头都修：可见范围在这里挡一道，角色在 guard 那边也配对。
  const visible = visibleScopes(role || undefined);
  const all = loadImpressions(dir);
  const live = collapse(all).filter((f) => f && f.id && !f.archived && !f.voided)
    .filter((f) => visible.includes(f.scope || SCOPE_SHARED));
  const timesById = new Map();
  for (const rec of all) {
    if (!rec?.id) continue;
    if (rec.reflectedAt) timesById.set(rec.id, (timesById.get(rec.id) || 0) + 1);
  }
  const out = [];
  for (const imp of live) {
    // 同一条一生最多被处理 maxPerItem 次：防 LLM 反复咀嚼同一条把它嚼烂。
    if ((timesById.get(imp.id) || 0) >= REFLECT_DEFAULTS.maxPerItem) continue;
    const last = Number(imp.reflectedAt) || 0;
    if (last && now - last < cd) continue;
    const weight = weightOf(imp, now);
    out.push({ imp, why: imp.suspect ? 'suspect-pending' : 'normal', weight });
  }
  out.sort((a, b) => {
    const as = a.imp.suspect ? 0 : 1;
    const bs = b.imp.suspect ? 0 : 1;
    if (as !== bs) return as - bs;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (Number(b.imp.createdAt) || 0) - (Number(a.imp.createdAt) || 0);
  });
  return out.slice(0, cap).map(({ imp, why }) => ({ imp, why }));
}

/**
 * 给一条印象找证据：最近 7 天里和它「在说同一件事」的原文。
 * 只读。返回 [{ ref, text, t, kind }]，ref 是原文 id（chat:<seq>）。
 */
export function collectEvidence(mem, imp, { now = Date.now(), limit = 3 } = {}) {
  const dir = dirOf(mem);
  if (!dir || !imp) return [];
  const since = Math.max(0, Number(imp.t || now) - REFRESH_WINDOW_MS);
  let recs = [];
  try {
    if (mem && typeof mem === 'object' && mem.store && typeof mem.store.query === 'function') {
      recs = mem.store.query({ from: since, to: now, limit: 0 });
    } else {
      recs = readRawWindow(dir, { from: since, to: now });
    }
  } catch { recs = []; }
  const q = grams(imp.text);
  const scored = [];
  for (const rec of recs) {
    const ref = rec.id ? String(rec.id) : makeId({ src: rec.src, seq: rec.seq });
    if (!ref || ref === imp.id) continue;
    const text = String(rec.text ?? '');
    if (!text) continue;
    const ov = overlap(q, grams(text));
    if (ov <= 0) continue;
    scored.push({
      ref,
      text: [...text].slice(0, REFLECT_DEFAULTS.evidenceQuoteChars).join(''),
      t: Number(rec.t) || 0,
      kind: rec.kind === 'impression' ? 'impression' : 'raw',
      _score: ov
    });
  }
  scored.sort((a, b) => b._score - a._score || b.t - a.t);
  return scored.slice(0, Math.max(1, Number(limit) || 3)).map(({ _score, ...rest }) => rest);
}

// ---------------------------------------------------------------- 门禁 / 外发

export function reflectDisabled(env = process.env, flags = {}) {
  if (String(env?.CM_NO_REFLECT ?? '') === '1') return 'disabled';
  if (flags?.noNet || String(env?.CM_REFLECT_NO_NET ?? '') === '1') return 'no-net';
  const key = flags.key !== undefined && flags.key !== null
    ? flags.key
    : (env?.CM_REFLECT_KEY || env?.SILICONFLOW_API_KEY || '');
  if (key) return null;
  // 环境变量里没有，就回去问 findKey()：key 更常见的位置是
  // work/qwen-rag/.secrets/siliconflow.key 这类文件，不是 export 出来的变量。
  // 这里不查，`cm reflect` / `cm-reflect` 会永远报「不跑（no-key）」——
  // 而精排（src/rerank.js）用的是同一个 findKey()，于是出现
  // 「精排能跑、反思永远不跑」这种自相矛盾的状态。
  // 与 reflectOnce 里的判定保持同一口径，避免一个说能跑、一个说不能。
  try {
    if (findKey()) return null;
  } catch { /* 探测失败就按没有 key 处理 */ }
  return 'no-key';
}

function reflectBase(env = process.env) {
  return env?.CM_REFLECT_BASE || env?.SILICONFLOW_BASE || DEFAULT_BASE;
}

function reflectModel(env = process.env) {
  return env?.CM_REFLECT_MODEL || DEFAULT_MODEL;
}

function verdictWord(v) {
  const s = String(v ?? '').toLowerCase().trim();
  if (['still-true', 'still_true', 'support', 'supported', 'true', 'keep', 'ok', 'y'].includes(s)) return 'still-true';
  if (['suspect', 'unclear', 'unsure', 'maybe', 'contradict', 'contradicted', 'conflict', 'n'].includes(s)) return 'suspect';
  if (['void', 'voided', 'expired', 'false', 'invalid'].includes(s)) return 'void';
  return null;
}

/** 把模型回的那坨文本抠成 JSON（容忍 ```json 围栏和前后废话）。 */
function parseModelJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const tryParse = (x) => { try { return JSON.parse(x); } catch { return null; } };
  const direct = tryParse(body);
  if (direct) return direct;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const obj = tryParse(body.slice(start, end + 1));
    if (obj) return obj;
  }
  const as = body.indexOf('[');
  const ae = body.lastIndexOf(']');
  if (as >= 0 && ae > as) return tryParse(body.slice(as, ae + 1));
  return null;
}

/**
 * 唯一出网口。
 *
 * 出去的只有这一批候选（≤3）+ 它们各自的证据（≤3 条，每条 ≤400 字），
 * 全部占位符化（r1/e1），不带 owner / hostname / 绝对路径 / sessionId。
 * 测试必须注入 fetchImpl；CM_NO_REFLECT=1 时调用方根本不会进来。
 */
export async function askReflect({
  candidates = [], evidences = [], key, base, model,
  timeoutMs = REFLECT_DEFAULTS.timeoutMs, fetchImpl
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const sent = { candidates: 0, evidences: 0, chars: 0, bytes: 0 };
  const cands = candidates.map((c) => (c && c.imp ? c.imp : c)).filter(Boolean);
  if (!cands.length) return { decisions: [], degraded: { reason: 'no-candidates', sent } };
  if (!key) return { decisions: [], degraded: { reason: 'no-key', sent } };

  // 证据先过隐私规则：命中就不发这条（宁可少判，不可泄露）。
  const usable = [];
  for (const ev of evidences) {
    if (!ev || !ev.ref) continue;
    if (PRIVACY_RE.test(String(ev.text ?? ''))) continue;
    usable.push({ ...ev, text: [...String(ev.text ?? '')].slice(0, REFLECT_DEFAULTS.evidenceQuoteChars).join('') });
  }
  if (!usable.length) return { decisions: [], degraded: { reason: 'privacy-filter', sent } };

  // 占位符映射只活在这个函数的内存里，绝不出现在任何落盘文件里。
  const rOf = new Map(cands.map((imp, i) => [imp.id, `r${i + 1}`]));
  const eOf = new Map(usable.map((ev, i) => [ev.ref, `e${i + 1}`]));

  const lines = [];
  for (const imp of cands) {
    lines.push(`【结论】${rOf.get(imp.id)}: ${imp.text}（来源=${sourceLabel(imp.source)}，${stampOf('day', imp.t)}，${scopeLabel(imp.scope)}）`);
  }
  for (const ev of usable) {
    lines.push(`【证据】${eOf.get(ev.ref)}: ${ev.text}（${stampOf('day', ev.t)}）`);
  }
  // ⚠️ `ref` 必须写进要求的格式里。原来只写了 verdict/evidence/why，
  // 而下面提取 decisions 时 `if (!ref || !verdict) continue` —— 模型照着
  // 字面要求回了个不带 ref 的对象，全被丢掉，最后落成 bad-json。
  // 实测 Qwen2.5-7B 对「只回 JSON」的理解就是「只回一个 JSON 值」，
  // 所以这里把完整形状直接摆出来，并说明要按候选逐条作答。
  const asked = cands.map((imp) => `请对 ${rOf.get(imp.id)} 输出 {"ref":"${rOf.get(imp.id)}","verdict":"support|contradict|expired|unclear","evidence":["e1"],"why":"<=60字"}`).join('\n');
  const askedTail = `\n只输出一个 JSON 数组，每个候选一个元素，形如：[{"ref":"r1","verdict":"support","evidence":["e1"],"why":"<=60字"}]。不要解释，不要代码块之外的话。`;
  let content = `${lines.join('\n')}\n${asked}${askedTail}`;
  // 总长度硬顶：超了从末尾证据开始砍，砍到装得下为止。
  //
  // 双尺子：字（码点）与字节都卡。施工令写的是「6000 字」，中文一字一码点，
  // 所以字是主口径；但同样 5048 个中文字的 UTF-8 是 14270 字节，是字面的 2.4 倍——
  // 隐私预算是防「流出多少内容」的，只按字算会让实际流量失控。两个都卡，
  // 取更紧的那个，谁先超就按谁砍。字节上限给 2 倍宽是因为英文/标点一字一字节，
  // 收紧到 6000 字节会把大量纯英文场景砍得过狠。
  const overBudget = (s) => countChars(s) > REFLECT_DEFAULTS.maxPayloadChars
    || Buffer.byteLength(s, 'utf8') > REFLECT_DEFAULTS.maxPayloadBytes;
  while (overBudget(content) && usable.length) {
    usable.pop();
    const kept = usable.map((ev) => `【证据】${eOf.get(ev.ref)}: ${ev.text}（${stampOf('day', ev.t)}）`);
    content = `${[lines.slice(0, cands.length), kept].flat().join('\n')}\n${asked}`;
  }
  if (overBudget(content)) content = [...content].slice(0, REFLECT_DEFAULTS.maxPayloadChars).join('');

  const body = {
    model: model || DEFAULT_MODEL,
    temperature: 0,
    max_tokens: 300,
    messages: [
      { role: 'system', content: '你是记忆自检器。只判断给定结论是否仍成立。只回 JSON。' },
      { role: 'user', content }
    ]
  };
  sent.candidates = cands.length;
  sent.evidences = usable.length;
  // chars 用码点口径（与预算 countChars 同一把尺子，别一个用 length 一个用码点）；
  // bytes 只是观测值——预算按「字」算是有意的：外发风险在于流出多少内容，
  // 不在于多少字节。但实际流量要能看见，否则以后没人说得清到底发了多少。
  sent.chars = countChars(content);
  sent.bytes = Buffer.byteLength(content, 'utf8');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || REFLECT_DEFAULTS.timeoutMs)) : null;
  let res;
  try {
    res = await fetchFn(`${base || DEFAULT_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    });
  } catch (e) {
    return { decisions: [], degraded: { reason: e?.name === 'AbortError' ? 'timeout' : `net-${e?.name || 'error'}`, sent } };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || !res.ok) return { decisions: [], degraded: { reason: `http-${res?.status ?? 0}`, sent } };
  let json;
  try { json = await res.json(); } catch { return { decisions: [], degraded: { reason: 'bad-json', sent } }; }
  const text = json?.choices?.[0]?.message?.content ?? json?.content ?? '';
  const parsed = parseModelJson(text);
  if (!parsed) return { decisions: [], degraded: { reason: 'bad-json', sent } };
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.decisions) ? parsed.decisions : [parsed]);
  const decisions = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const ref = String(raw.ref ?? raw.r ?? '').trim();
    const verdict = verdictWord(raw.verdict ?? raw.v);
    if (!ref || !verdict) continue;
    decisions.push({
      ref,
      verdict,
      evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).map((x) => String(x)),
      why: noteOf(raw.why ?? raw.note, 200)
    });
  }
  if (!decisions.length) return { decisions: [], degraded: { reason: 'bad-shape', sent } };
  return { decisions, degraded: null };
}

// ---------------------------------------------------------------- 决策归一（纯函数）

function canVoidNormal(imp, evRefs, evidenceByRef) {
  // normal → voided 想跳过存疑，只有两种情形允许（§4.2）。
  const newer = evRefs.map((r) => evidenceByRef.get(r)).filter(Boolean).filter((ev) => (Number(ev.t) || 0) > (Number(imp.t) || 0));
  const negated = newer.some((ev) => NEGATION_RE.test(String(ev.text ?? '')));
  if (negated) return { ok: true, why: '原文里出现明确否定句' };
  if (imp.source === 'imagined') return { ok: false, reason: 'void-needs-two-rounds' };
  return { ok: false, reason: 'void-needs-suspect' };
}

function refsOf(list) {
  return list.map((x) => String(x));
}

/**
 * 把 LLM 的判定压成「可以安全落盘的 plan」。
 *
 * 这里承担全部硬约束（全是写死的规则，不给模型自由裁量）：
 *   · refs 必须是本轮真实证据 → 假 id 整轮不写
 *   · 一轮 ≤1 void、≤2 suspect，超出丢弃记 clipped（不攒到下一轮）
 *   · suspect → void 必须两轮（已有存疑记录）或存疑满 24h
 *   · normal → void 只有「原文明确否定」才允许，否则降级为 suspect
 */
export function normalizeDecisions(decisions, { candidates = [], evidences = [], state = {}, now = Date.now() } = {}) {
  const cands = candidates.map((c) => (c && c.imp ? c.imp : c)).filter(Boolean);
  const evList = Array.isArray(evidences) ? evidences : [];
  const byRefToCand = new Map(cands.map((imp, i) => [`r${i + 1}`, imp]));
  const byRefToEv = new Map(evList.map((ev, i) => [`e${i + 1}`, ev]));
  const evidenceByRef = new Map(evList.map((ev) => [String(ev.ref), ev]));
  const candIds = new Set(cands.map((imp) => imp.id));
  const evIds = new Set(evList.map((ev) => String(ev.ref)));

  const rejected = [];
  const plan = [];
  let clipped = 0;
  let aborted = false;
  let suspectCount = 0;
  let voidCount = 0;

  const by = { actor: 'cm-reflect', owner: resolveOwner(), role: resolveRole() };

  for (const d of Array.isArray(decisions) ? decisions : []) {
    const ref = String(d?.ref ?? '').trim();
    const imp = byRefToCand.get(ref);
    if (!imp) { rejected.push({ id: ref || '(空)', reason: 'unknown-candidate' }); continue; }
    const verdict = d?.verdict;
    if (!['still-true', 'suspect', 'void'].includes(verdict)) { rejected.push({ id: imp.id, reason: 'bad-verdict' }); continue; }
    if (imp.voided) { rejected.push({ id: imp.id, reason: 'already-voided' }); continue; }

    // 占位符 → 真实 ref；有一个不认得的，整轮不写。
    const evRefs = [];
    let bad = false;
    for (const x of Array.isArray(d?.evidence) ? d.evidence : []) {
      const ev = byRefToEv.get(String(x));
      if (!ev) { bad = true; break; }
      const real = String(ev.ref);
      if (!evIds.has(real) && !candIds.has(real)) { bad = true; break; }
      evRefs.push(real);
    }
    if (bad) { rejected.push({ id: imp.id, reason: 'invalid-evidence' }); aborted = true; continue; }

    if (verdict === 'still-true') {
      if (!imp.suspect) { rejected.push({ id: imp.id, reason: 'no-change' }); continue; }
      // 「补到证据」才允许撤疑：模型说还成立 + 引了证据。无证据的 still-true 不动。
      if (!evRefs.length) { rejected.push({ id: imp.id, reason: 'no-evidence' }); continue; }
      plan.push({
        id: imp.id,
        action: 'clear',
        patch: {
          suspect: null,
          cleared: { by, at: now, why: `复核：证据 ${evRefs.join(', ')} 支持原结论` }
        }
      });
      continue;
    }

    if (verdict === 'suspect') {
      if (imp.suspect) { rejected.push({ id: imp.id, reason: 'already-suspect' }); continue; }
      if (!evRefs.length) { rejected.push({ id: imp.id, reason: 'no-evidence' }); continue; }
      if (suspectCount >= REFLECT_DEFAULTS.maxSuspectsPerRound) { clipped++; rejected.push({ id: imp.id, reason: 'clipped-suspect' }); continue; }
      suspectCount++;
      plan.push({
        id: imp.id,
        action: 'suspect',
        patch: {
          suspect: {
            by,
            at: now,
            because: {
              kind: 'contradicted',
              refs: refsOf(evRefs),
              quote: [...String(evidenceByRef.get(evRefs[0])?.text ?? '')].slice(0, 120).join(''),
              note: noteOf(d.why) || '新证据与原结论冲突'
            }
          }
        }
      });
      continue;
    }

    // verdict === 'void'
    const evCount = evRefs.length;
    const hadSuspect = !!imp.suspect;
    const suspectAge = hadSuspect ? now - (Number(imp.suspect.at) || now) : 0;
    let allowed;
    if (hadSuspect) {
      // 两轮确认：存疑是上一轮写的（不是本轮），且本轮要么判冲突、要么存疑已满 24h。
      const twoRounds = true; // 候选是「本轮重读后的状态」，存疑必然来自更早一轮的写入
      allowed = twoRounds && (evCount >= 1 || suspectAge >= VOID_WAIT_MS)
        ? { ok: true }
        : { ok: false, reason: 'void-needs-evidence' };
    } else {
      allowed = canVoidNormal(imp, evRefs, evidenceByRef);
    }
    if (!allowed.ok) {
      // 降级成存疑（不能因为模型一句话就永久清掉记忆）。
      if (imp.suspect) { rejected.push({ id: imp.id, reason: allowed.reason }); continue; }
      if (!evRefs.length) { rejected.push({ id: imp.id, reason: 'no-evidence' }); continue; }
      if (suspectCount >= REFLECT_DEFAULTS.maxSuspectsPerRound) { clipped++; rejected.push({ id: imp.id, reason: 'clipped-suspect' }); continue; }
      suspectCount++;
      plan.push({
        id: imp.id,
        action: 'suspect',
        patch: {
          suspect: {
            by,
            at: now,
            because: {
              kind: 'contradicted',
              refs: refsOf(evRefs),
              quote: [...String(evidenceByRef.get(evRefs[0])?.text ?? '')].slice(0, 120).join(''),
              note: noteOf(`原判作废未满两轮（${allowed.reason}），先记存疑${d.why ? '：' + d.why : ''}`)
            }
          }
        }
      });
      continue;
    }
    if (!evRefs.length) { rejected.push({ id: imp.id, reason: 'no-evidence' }); continue; }
    if (voidCount >= REFLECT_DEFAULTS.maxVoidsPerRound) { clipped++; rejected.push({ id: imp.id, reason: 'clipped-void' }); continue; }
    voidCount++;
    plan.push({
      id: imp.id,
      action: 'void',
      patch: {
        voided: {
          by,
          at: now,
          why: noteOf(d.why) || (hadSuspect ? '存疑复核后确认不成立' : '原文里出现明确否定'),
          because: {
            kind: 'contradicted',
            refs: refsOf(evRefs),
            quote: [...String(evidenceByRef.get(evRefs[0])?.text ?? '')].slice(0, 120).join(''),
            note: noteOf(d.why, 200)
          }
        }
      }
    });
  }

  if (aborted) return { plan: [], clipped, rejected, roundId: null };

  // 轮次 id 由「这一轮到底要做什么」决定：同样的 plan 重跑得到同样的 id → 幂等。
  const sig = plan.map((p) => `${p.id}|${p.action}|${(p.patch?.suspect?.because?.refs || p.patch?.voided?.because?.refs || []).join(',')}|${p.patch?.cleared?.why || p.patch?.voided?.why || ''}`).sort().join(';');
  const roundId = plan.length ? `r_${hashOf(sig).slice(0, 8)}` : null;
  for (const p of plan) {
    p.patch.reflectRound = roundId;
    p.patch.reflectedAt = now;
  }
  return { plan, clipped, rejected, roundId };
}

// ---------------------------------------------------------------- 本地规则（无网/降级时）

function localDecisions({ candidates, evidences }) {
  const cands = candidates.map((c) => (c && c.imp ? c.imp : c)).filter(Boolean);
  const evList = Array.isArray(evidences) ? evidences : [];
  const out = [];
  cands.forEach((imp, i) => {
    const mine = evList.filter((ev) => !ev.candRef || ev.candRef === imp.id);
    const neg = mine.find((ev) => NEGATION_RE.test(String(ev.text ?? '')) && (Number(ev.t) || 0) > (Number(imp.t) || 0));
    if (!neg) return;
    const idx = evList.indexOf(neg);
    out.push({
      ref: `r${i + 1}`,
      verdict: 'suspect', // 本地规则只能产存疑，绝不产作废
      evidence: [`e${idx + 1}`],
      why: '本地规则：证据里出现否定句'
    });
  });
  return out;
}

// ---------------------------------------------------------------- 留痕（唯一写口）

function patchHasIdentityChange(patch, base) {
  for (const key of ['text', 'source', 'scope', 'owner', 'id', 'v', 'category', 'createdAt', 't']) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      if (JSON.stringify(patch[key]) !== JSON.stringify(base[key])) return true;
    }
  }
  return false;
}

/**
 * 把 plan 落盘。内部自己 withLock，调用方不要在外面加锁。
 * 所有行先在内存里拼好，最后一步才一次 appendFileSync —— 失败不写半条。
 */
export function applyPlan(dir, { plan = [], roundId = null, now = Date.now() } = {}) {
  const list = Array.isArray(plan) ? plan.filter((p) => p && p.id && p.action) : [];
  if (!list.length) return { applied: [], skipped: [] };

  try {
    return withLock(dir, () => {
      // 重读：锁外算的那份可能已经过时（别的会话也在写）。
      const all = loadImpressions(dir);
      const byId = new Map(collapse(all).map((rec) => [rec.id, rec]));
      // 丙方案（2026-11-21）：印象层现在按 scope 分两份文件，一批里可能同时有
      // work 与 life 的记录。先按「目标文件」分桶，最后每桶一次 appendLines ——
      // 「先拼好再一次性落盘、失败不写半条」的承诺按桶成立。
      const buckets = new Map();
      const applied = [];
      const skipped = [];
      for (const p of list) {
        const base = byId.get(p.id);
        if (!base) { skipped.push({ id: p.id, reason: 'missing' }); continue; }
        if (roundId && base.reflectRound === roundId) { skipped.push({ id: p.id, reason: 'already-applied' }); continue; }
        if (base.voided) { skipped.push({ id: p.id, reason: 'already-voided' }); continue; }
        if (patchHasIdentityChange(p.patch, base)) { skipped.push({ id: p.id, reason: 'invalid-rewrite' }); continue; }
        if (p.action === 'clear' && !base.suspect) { skipped.push({ id: p.id, reason: 'no-suspect' }); continue; }
        if (p.action === 'suspect' && base.suspect) { skipped.push({ id: p.id, reason: 'already-suspect' }); continue; }
        // 门禁：被拒就丢掉这条，不绕。
        // 冻结与「这一层没权限」是两件事，必须分流（N-01 接线 2026-11-19）：
        // 冻的是整库，跑去改 CM_ROLE 没用，报 readonly-scope 会把人引到错的地方。
        try {
          assertWritable('反思标记', base.scope || SCOPE_SHARED, dir);
        } catch (e) {
          skipped.push({ id: p.id, reason: e && e.code === 'CM_FROZEN' ? 'frozen' : 'readonly-scope' });
          continue;
        }
        const next = { ...base, ...(p.patch || {}) };
        if (roundId) next.reflectRound = roundId;
        next.reflectedAt = now;
        // 逐字节守住原文：「不删原文、不改原意」的机器保证。
        if (next.text !== base.text || next.source !== base.source || (next.scope || SCOPE_SHARED) !== (base.scope || SCOPE_SHARED)) {
          skipped.push({ id: p.id, reason: 'invalid-rewrite' });
          continue;
        }
        // 写回这条记录自己那一份文件：batch 里混着 life 与 work 时不能全塞进被追踪的那个。
        const target = impressionsFileForScope(dir, next.scope);
        if (!buckets.has(target)) buckets.set(target, []);
        buckets.get(target).push(next);
        applied.push({ id: p.id, action: p.action });
      }
      if (!applied.length) return { applied: [], skipped };
      for (const [target, lines] of buckets) appendLines(target, lines);
      return { applied, skipped };
    }, { timeoutMs: 2_000 });
  } catch (e) {
    if (/拿不到记忆库写锁/.test(String(e?.message ?? ''))) {
      return { applied: [], skipped: list.map((p) => ({ id: p.id, reason: 'skip-locked' })), locked: true };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- 单个状态标记

function loadTarget(dir, id) {
  return collapse(loadImpressions(dir)).find((rec) => rec.id === id) || null;
}

/**
 * 标存疑。三要素 by / at / because 缺一不写（返回 ok:false）。
 * because.refs 必须全都指向现存记录，否则整条拒写。
 */
export function markSuspect(dir, id, { by, at, because } = {}) {
  // 冻结闸（N-01 接线）：这几个函数是「不抛、只回报」的契约（测试与 CLI 都按返回值判），
  // 所以这里返回 {ok:false, reason:'frozen'} 而不是抛 —— 抛会把 cm close 与反思循环带崩。
  if (frozenNow(dir, '反思标记')) return { ok: false, reason: 'frozen' };
  const byBad = validateBy(by);
  if (byBad) return { ok: false, reason: byBad };
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return { ok: false, reason: 'missing-at' };
  const becauseBad = validateBecause(dir, because);
  if (becauseBad) return { ok: false, reason: becauseBad };
  const base = loadTarget(dir, id);
  if (!base) return { ok: false, reason: 'not-found' };
  if (base.voided) return { ok: false, reason: 'already-voided' };
  const next = {
    ...base,
    suspect: { by, at: when, because: { kind: BECAUSE_KINDS.includes(because.kind) ? because.kind : 'contradicted', ...because } },
    reflectedAt: when
  };
  // 写回这条记录自己那份文件（丙方案）：标一条 life 印象时不能写进被追踪的那份。
  appendLines(impressionsFileForScope(dir, next.scope), [next]);
  return { ok: true, impression: next };
}

/**
 * 标作废。终态：不可撤销（要恢复只能 cm add 一条新印象）。
 * 三要素 by / at / why 必填；because 可选，但给了就同样校验 refs。
 */
export function markVoided(dir, id, { by, at, why, because } = {}) {
  // 同上：返回 {ok:false, reason:'frozen'}，不抛。
  if (frozenNow(dir, '反思标记')) return { ok: false, reason: 'frozen' };
  const byBad = validateBy(by);
  if (byBad) return { ok: false, reason: byBad };
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return { ok: false, reason: 'missing-at' };
  const reason = noteOf(why, 300);
  if (!reason) return { ok: false, reason: 'missing-why' };
  let checked = null;
  if (because) {
    const becauseBad = validateBecause(dir, because);
    if (becauseBad) return { ok: false, reason: becauseBad };
    checked = { kind: BECAUSE_KINDS.includes(because.kind) ? because.kind : 'contradicted', ...because };
  }
  const base = loadTarget(dir, id);
  if (!base) return { ok: false, reason: 'not-found' };
  if (base.voided) return { ok: false, reason: 'already-voided' };
  const next = { ...base, voided: { by, at: when, why: reason, because: checked }, reflectedAt: when };
  appendLines(impressionsFileForScope(dir, next.scope), [next]);
  return { ok: true, impression: next };
}

/** 撤疑（补到证据/被证伪）。why 必填——撤疑也是状态变化，得留原因。 */
export function clearSuspect(dir, id, { by, at, why } = {}) {
  // 同上：返回 {ok:false, reason:'frozen'}，不抛。
  if (frozenNow(dir, '反思标记')) return { ok: false, reason: 'frozen' };
  const byBad = validateBy(by);
  if (byBad) return { ok: false, reason: byBad };
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return { ok: false, reason: 'missing-at' };
  const reason = noteOf(why, 300);
  if (!reason) return { ok: false, reason: 'missing-why' };
  const base = loadTarget(dir, id);
  if (!base) return { ok: false, reason: 'not-found' };
  if (base.voided) return { ok: false, reason: 'already-voided' };
  if (!base.suspect) return { ok: false, reason: 'no-suspect' };
  const next = { ...base, suspect: null, cleared: { by, at: when, why: reason }, reflectedAt: when };
  appendLines(impressionsFileForScope(dir, next.scope), [next]);
  return { ok: true, impression: next };
}

/**
 * 作废三行（人肉可读）。
 *   ① 原文 + 来源/时间
 *   ② 存疑：哪天、谁标的、为什么
 *   ③ 作废：哪天、为什么、ref
 */
export function renderVoidedLines(imp, { dateFormat } = {}) {
  if (!imp || !imp.voided) return [];
  const lines = [];
  lines.push(`${imp.text}（来源：${sourceLabel(imp.source)} / ${stampOf(dateFormat, imp.t, 'datetime')} ${scopeLabel(imp.scope)}对话）`);
  const sus = imp.suspect;
  if (sus && sus.at) {
    const note = noteOf(sus.because?.note || sus.because?.quote || (sus.because?.kind === 'contradicted' ? '原文冲突' : ''), 60);
    lines.push(`  存疑：${stampOf(dateFormat, sus.at, 'datetime')} 由 ${sus.by?.actor || 'cm-reflect'} 标记${note ? ` —— ${note}` : ''}`);
  }
  const v = imp.voided;
  const refs = Array.isArray(v.because?.refs) ? v.because.refs : [];
  lines.push(`  作废：${stampOf(dateFormat, v.at, 'datetime')}，因为${v.why}${refs.length ? `（ref ${refs.join(', ')}）` : ''}`);
  return lines;
}

// ---------------------------------------------------------------- 一轮

function appendAudit(dir, entry) {
  try {
    const file = path.join(dir, 'raw', AUDIT_FILE);
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 日志写不进去不能反过来影响记忆 */ }
}

function bucketOf(state, now) {
  const b = state.hourBucket || { hourStart: 0, count: 0 };
  const start = hourStartOf(now);
  if (Number(b.hourStart) !== start) return { hourStart: start, count: 0 };
  return { hourStart: start, count: Number(b.count) || 0 };
}

/**
 * 跑一轮。
 *
 * 顺序不能换：门禁 → 选目标 → 证据 → 外发 → 归一 → 留痕 → 状态。
 * 任何一步失败都不写记忆（审计和失败计数除外）。
 */
export async function reflectOnce(mem, {
  now = Date.now(), fetchImpl, env = process.env,
  dryRun = false, force = false, noNet = false, max, intervalMs
} = {}) {
  const dir = dirOf(mem);
  const base = { ok: false, state: 'skipped', roundId: null, plan: [], applied: [], skipped: [], degraded: null, reason: null };
  if (!dir) return { ...base, reason: 'no-dir' };
  if (mem && typeof mem === 'object' && mem.canWrite === false) return { ...base, reason: 'read-only' };

  // ① 门禁（便宜的先判）
  const key = env?.CM_REFLECT_KEY || env?.SILICONFLOW_API_KEY || (() => { try { return findKey(); } catch { return ''; } })();
  const off = reflectDisabled(env, { noNet, key });
  if (off === 'disabled') {
    // CM_NO_REFLECT=1：零外发、零写入、零成本返回。
    return { ...base, ok: true, state: 'skipped', reason: 'disabled' };
  }
  const state = loadReflectState(dir, now);
  const failures = Number(state.consecutiveFailures) || 0;
  // 醒来的间隔要跟着调用方的 --interval 走（2026-11-06）。
  // 以前这里写死 REFLECT_DEFAULTS.intervalMs（600s），于是 --interval 120
  // 只改了循环多久醒一次，每一轮仍被 too-soon 挡掉——循环在转、日志在长、
  // 一轮也不真跑。缩短周期的第一天就踩到了这个。
  const baseIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : REFLECT_DEFAULTS.intervalMs;
  const wait = failures ? REFLECT_DEFAULTS.backoffSec[Math.min(failures - 1, REFLECT_DEFAULTS.backoffSec.length - 1)] * 1000 : baseIntervalMs;
  if (!force) {
    if (now - (Number(state.lastRoundAt) || 0) < Math.max(wait, REFLECT_DEFAULTS.minIntervalMs)) {
      return { ...base, ok: true, reason: 'too-soon' };
    }
    const bucket0 = bucketOf(state, now);
    if (bucket0.count >= REFLECT_DEFAULTS.hourCap) return { ...base, ok: true, reason: 'hour-cap' };
    const stamp = rawStampOf(mem);
    if (state.lastEvidenceStamp && stamp === state.lastEvidenceStamp) return { ...base, ok: true, reason: 'no-new-evidence' };
  }
  const bucket = bucketOf(state, now);
  if (bucket.count >= REFLECT_DEFAULTS.hourCap && !force) return { ...base, ok: true, reason: 'hour-cap' };

  // 锁被别人占着：本轮算了（那是别人的正常写，不是我们的失败）。
  if (lockBusy(dir)) {
    return { ...base, ok: true, state: 'skipped', reason: 'skip-locked' };
  }

  // ② 选目标
  // role 必须传下去（2026-11-06）：选人阶段就要按角色可见范围过滤，
  // 否则会选出执行阶段写不了的条目，一轮白跑还留下误导性的 readonly-scope。
  const cands = pendingCandidates(dir, {
    now,
    role: resolveRole(),
    max: Number.isFinite(max) && max > 0 ? max : REFLECT_DEFAULTS.maxCandidates,
    cooldownMs: force ? 0 : REFLECT_DEFAULTS.cooldownMs
  });
  if (!cands.length) {
    const next = { ...state, lastRoundAt: now };
    try { withLock(dir, () => saveReflectState(dir, next), { timeoutMs: 2_000 }); } catch { /* 状态写不进去不致命 */ }
    return { ...base, ok: true, state: 'no-change', reason: 'no-candidates' };
  }

  // ③ 证据（只读；只碰当前角色看得见的层）
  const evidences = [];
  for (const c of cands) {
    const list = collectEvidence(mem, c.imp, { now, limit: 3 });
    for (const ev of list) evidences.push({ ...ev, candRef: c.imp.id });
  }

  // ④/⑤ 外发判断 + 外发
  let decisions = [];
  let degraded = null;
  let fetchCalls = 0;
  const localMode = off === 'no-net' || off === 'no-key';
  if (localMode) {
    decisions = localDecisions({ candidates: cands, evidences });
    degraded = { reason: off, sent: { candidates: cands.length, evidences: evidences.length, chars: 0 } };
  } else {
    let r;
    try {
      fetchCalls++;
      r = await askReflect({
        candidates: cands,
        evidences,
        key,
        base: reflectBase(env),
        model: reflectModel(env),
        timeoutMs: REFLECT_DEFAULTS.timeoutMs,
        fetchImpl
      });
    } catch (e) {
      r = { decisions: [], degraded: { reason: `ask-${e?.name || 'error'}`, sent: null } };
    }
    if (r.degraded) {
      // 失败不写：审计 + 失败计数，记忆一个字节都不动。
      const next = { ...state, consecutiveFailures: failures + 1 };
      try { withLock(dir, () => saveReflectState(dir, next), { timeoutMs: 2_000 }); } catch { /* ignore */ }
      appendAudit(dir, {
        at: now, roundId: null, state: 'degraded', reason: r.degraded.reason,
        degraded: r.degraded, candidates: cands.length, applied: [], skipped: [], rendered: []
      });
      return {
        ...base, ok: false, state: 'degraded', degraded: r.degraded,
        reason: r.degraded.reason, candidates: cands.length, fetchCalls
      };
    }
    decisions = r.decisions;
  }

  // ⑥ 归一（纯函数；dry-run 到这一步就走）
  const normalized = normalizeDecisions(decisions, { candidates: cands, evidences, state, now });
  const plan = normalized.plan;
  const clipped = normalized.clipped;
  const rejected = normalized.rejected;
  const roundId = normalized.roundId;

  if (dryRun) {
    return {
      ...base, ok: true, state: 'no-change', reason: 'dry-run', roundId,
      plan, applied: [], skipped: [], clipped, rejected, degraded,
      candidates: cands.length, fetchCalls
    };
  }

  if (!plan.length) {
    // 没有可落盘的判定：本轮成功但无变化，仍然记 lastRoundAt / 小时桶。
    const next = {
      ...state,
      lastRoundAt: now,
      consecutiveFailures: 0,
      lastRoundId: null,
      hourBucket: { hourStart: bucket.hourStart, count: bucket.count + 1 },
      lastEvidenceStamp: rawStampOf(mem)
    };
    try { withLock(dir, () => saveReflectState(dir, next), { timeoutMs: 2_000 }); } catch { /* ignore */ }
    const fatal = rejected.find((x) => x.reason === 'invalid-evidence');
    appendAudit(dir, {
      at: now, roundId: null, state: 'no-change', reason: fatal ? 'invalid-evidence' : (degraded?.reason || 'no-plan'),
      degraded, candidates: cands.length, applied: [], skipped: skippedOf(rejected), rendered: []
    });
    return {
      ...base, ok: true, state: 'no-change', roundId: null,
      plan: [], applied: [], skipped: skippedOf(rejected), clipped, rejected,
      degraded, reason: fatal ? 'invalid-evidence' : (degraded?.reason || 'no-plan'),
      candidates: cands.length, fetchCalls
    };
  }

  // ⑦ 留痕（唯一写窗口）
  let result;
  try {
    result = applyPlan(dir, { plan, roundId, now });
  } catch (e) {
    appendAudit(dir, { at: now, roundId, state: 'error', reason: `apply-${e?.message || 'error'}`, degraded, candidates: cands.length, applied: [], rendered: [] });
    const next = { ...state, consecutiveFailures: failures + 1 };
    try { withLock(dir, () => saveReflectState(dir, next), { timeoutMs: 2_000 }); } catch { /* ignore */ }
    return { ...base, ok: false, state: 'error', reason: 'apply-failed', roundId, plan, candidates: cands.length, fetchCalls };
  }
  if (result.locked) {
    return { ...base, ok: true, state: 'skipped', reason: 'skip-locked', roundId, plan, candidates: cands.length, fetchCalls };
  }

  // ⑧ 收尾（状态后写：写失败也不影响记忆，下一轮靠 reflectRound 去重）
  const handled = { ...state.handled };
  for (const a of result.applied) handled[a.id] = { at: now, round: roundId, verdict: a.action };
  const next = {
    ...state,
    lastRoundAt: now,
    consecutiveFailures: 0,
    lastRoundId: roundId,
    lastPlanHash: hashOf(JSON.stringify(plan.map((p) => [p.id, p.action]))),
    hourBucket: { hourStart: bucket.hourStart, count: bucket.count + 1 },
    lastEvidenceStamp: rawStampOf(mem),
    handled
  };
  try { withLock(dir, () => saveReflectState(dir, next), { timeoutMs: 2_000 }); } catch { /* ignore */ }

  // 作废三行的渲染文本只进审计，绝不回写 text。
  const rendered = [];
  for (const a of result.applied) {
    if (a.action !== 'void') continue;
    const imp = collapse(loadImpressions(dir)).find((rec) => rec.id === a.id);
    if (imp) rendered.push(...renderVoidedLines(imp));
  }
  appendAudit(dir, {
    at: now, roundId, state: 'changed',
    reason: degraded?.reason || null,
    degraded, candidates: cands.length,
    applied: result.applied, skipped: result.skipped.concat(skippedOf(rejected)),
    clipped, rendered
  });

  return {
    ...base,
    ok: true,
    state: 'changed',
    roundId,
    plan,
    applied: result.applied,
    skipped: result.skipped.concat(skippedOf(rejected)),
    clipped,
    rejected,
    degraded,
    reason: degraded?.reason || null,
    candidates: cands.length,
    fetchCalls
  };
}

function skippedOf(rejected) {
  return rejected.map((r) => ({ id: r.id, reason: r.reason }));
}
