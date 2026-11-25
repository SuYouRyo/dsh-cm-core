// L0–L3 层级蒸馏（B-08 阶段2，2026-11-20）。
//
// 工单出处：doc-02-done/工单-开源机制借鉴与记忆融合-20261113.md 阶段2
//   2.1 在现有 scope 基础上引入 kind 层级字段：
//       L0 Episode = events.jsonl 原始对话与动作（不破坏现有）
//       L1 Fact    = 提炼出的事实
//       L2 Profile = 人物画像与长期习惯
//       L3 Lesson  = 经验教训
//   2.2 独立的离线脚本 cm-consolidate：扫当天的 L0 → 聚类/重放/抽象 → 写 L1-L3（仍 JSONL）
//   红线：**蒸馏过程不修改原始 L0 记录，只追加高维记录。**
//
// 字段用英文 layer='fact'|'profile'|'lesson'，**不用 "L1"/"L2"/"L3" 字符串**。
// 理由：仓内 "L1/L2/L3" 已被情绪层 W13 占用（emotion.js:451 门控 L2、:462 注入块 L1、
// emotion-words.js:299 心境一致 L2），同名不同义会让两个模块的日志与用例互相误读。
//
// 三条设计纪律（写歪了这一步就变成「用 AI 编造用户画像」）：
//   ① 只抄不猜：每条 L1/L2/L3 都由真实 L0 原文片段或真实统计量构成，
//      **不生成原文里没有的形容词、判断、因果**。所以这里是确定性规则，不是 LLM。
//   ② 必须可追溯：每条都带 evidenceIds（真实 L0 record id）；没有证据的条目一律不写。
//   ③ 幂等可重跑：id = layer + 归一化文本 + 首个证据 id 的哈希；同一天重跑只补新增。
//
// 为什么不用 LLM（reflect.js 的 askReflect 已有出网口）：阶段2 验收要求
//   「跑一次 cm-consolidate 后实贴输出多少条 L1/L2，并证明 L0 行数未变」——
//   这是可重复、可审计的离线动作。接模型会让同一份 L0 每次跑出不同的画像，
//   而且红线不允许把 life 层原文发出去。
//
// 为什么另起模块而不塞进 reflect.js：reflect 的头注写着三条不可退让
//   （只做减法不新增印象 / 失败不写 / 门禁不绕），阶段2 是**加法**。混进去
//   迟早有人为了「让反思能补一条」把只做减法那条改掉。

import fs from 'node:fs';
import path from 'node:path';
import {
  withLock, assertWritable, visibleScopes, resolveRole, hashOf, SCOPE_SHARED
} from './shared.js';
import { fmtDate, fmtDayKey } from './localtime.js';

export const LAYER_VERSION = 1;
export const LAYER_DIRNAME = 'layers';
/** 层级顺序：由低到高。别改顺序，回执里的「提取了多少条」按这个顺序印。 */
export const LAYER_ORDER = Object.freeze(['fact', 'profile', 'lesson']);
export const LAYER_LABEL = Object.freeze({ fact: 'L1 事实', profile: 'L2 画像', lesson: 'L3 经验' });

// ── 规则表 ────────────────────────────────────────────────────────────────
// 每条规则的 re 只做**定位**（这句话里出现了「我喜欢/我讨厌/我习惯」这类自述句式），
// 命中的原文整句（≤120 字）原样当 L1，不改写、不总结。改写就等于替用户说话。

/** 自我陈述类事实：偏好、习惯、状态、经历。 */
export const FACT_RULES = Object.freeze([
  { id: 'preference', re: /我(?:很|挺|特别|比较|最|也)?(?:喜欢|爱吃|爱喝|爱看|爱玩|讨厌|不爱|不吃|不喝|受不了)/ },
  { id: 'habit', re: /我(?:习惯|通常|一般|总是|经常|每天|每周|从小|以前就)/ },
  { id: 'state', re: /我(?:最近|现在|今天|这两天)(?:在|有|没|挺|很|一直|老是|总是)/ },
  { id: 'plan', re: /我(?:要|会|准备|打算|想)(?:去|做|把|给|先|再|明天|下周|周末)/ },
  { id: 'relation', re: /我(?:妈|爸|姐|哥|弟|妹|朋友|同事|对象|老婆|老公|孩子)/ }
]);

/** 用户给出的明确要求/纠正 → L3。只收带祈使或纠正标记的原话。 */
export const LESSON_RULES = Object.freeze([
  { id: 'directive', re: /(?:以后|下次|今后)(?:别|不要|不用|记得|要)/ },
  { id: 'correction', re: /(?:不是这样|不是这个意思|我说的是|你又|我说过|别再|不要再)/ },
  { id: 'remember', re: /(?:记住|记一下|别忘了|一定要)/ }
]);

/**
 * L2 画像的主题桶。
 *
 * 为什么画像用「主题频次」而不是「性格形容词」：频次是可核对的统计量，
 * 形容词是判断。红线（validate.js 拒人格诊断）同样适用于画像 ——
 * 「他最近 N 天提到 M 次工作」是事实，「他是个工作狂」是判决。
 */
export const PROFILE_THEMES = Object.freeze([
  { id: 'work', name: '工作与项目', re: /工作|项目|代码|部署|服务|仓库|测试|工单|上线|服务器|脚本|接口|编译/ },
  { id: 'health', name: '身体与作息', re: /睡|困|累|头疼|腰酸|眼睛|感冒|体检|医院|药|嗓子|胃|肩|颈椎|失眠/ },
  { id: 'food', name: '吃饭与饮食', re: /吃|饭|外卖|奶茶|咖啡|辣|香菜|酒|水果|早饭|午饭|晚饭/ },
  { id: 'people', name: '家人与朋友', re: /妈|爸|姐|哥|朋友|同事|老师|家里|对象/ },
  { id: 'plan', name: '计划与约定', re: /明天|下周|周末|计划|打算|约定|答应|截止|deadline/ },
  { id: 'emotion', name: '情绪与状态', re: /难受|焦虑|烦|开心|高兴|低落|崩溃|压力|委屈|生气|想你/ }
]);

/** 归一化：去掉标点空白，用来判重（不改展示文本）。 */
export function normText(s) {
  return String(s == null ? '' : s).replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** 按中文句末标点切句，保留原句（不 trim 内部空白以免改字）。 */
export function splitClauses(text) {
  return String(text == null ? '' : text)
    .split(/[。！？；!?;\n]+/u)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function clauseOk(c) {
  if (!c) return false;
  const n = [...c].length;
  // 太短（「我喜欢」）没有信息；太长（整段复述）不是一句事实。
  return n >= 5 && n <= 120;
}

/**
 * 是不是「文档碎片」而不是他自己说的话。
 *
 * 实测教训（2026-11-20 真库跑批）：不挡这一层，L1 里会灌满从工单/表格/教程里
 * 粘过来的行 —— 「| "我想做自己的衣服卖给别人" | 教程 4 |」「├─ "我想把 Avatar
 * 导出到 VRM"」都被当成了他的自述。它们确实是 role=user 的 L0 记录，但那是他
 * **粘贴**进来的文档，不是他说的话。把粘贴内容当成画像，比不蒸馏更坏。
 *
 * 判据只用「自然口语里极少出现的字符」：表格竖线、代码反引号、标题井号、
 * 树形符号、等号、成对引号。宁可漏几条真话，也不能把文档当自述。
 */
const DOC_MARKERS = /[|`*#>├└│─※✅❌=]/;
const DOC_HEAD = /^(?:[-·•*+]\s*|\d+[.、)]\s*)/;
const DOC_QUOTES = /["“”「」『』]/;

function docish(c) {
  if (DOC_MARKERS.test(c)) return true;
  if (DOC_HEAD.test(c)) return true;
  if (DOC_QUOTES.test(c)) return true;
  return false;
}

/**
 * 是不是一句**在问他**的话，而不是在说他自己的事。
 *
 * 「我朋友要还原模型，你能出个总结吗」「我想做这个，你觉得怎么样」——
 * 都带「我…」的句式，但那是提问，提不出任何关于他的长期事实。
 * 判据取最保守的三样：句末问号、句末疑问语气词、句中「你看/你觉得/你能/好不好」。
 */
const ASK_TAIL = /[?？]$/;
const ASK_PARTICLE = /[吗呢嘛]$/;
const ASK_INNER = /(?:你觉得|你看|你能|你可以|你帮|好不好|行不行|对不对|是不是|怎么样)/;

function askish(c) {
  if (ASK_TAIL.test(c)) return true;
  if (ASK_PARTICLE.test(c)) return true;
  if (ASK_INNER.test(c)) return true;
  return false;
}

export function layerFileOf(dir, layer) {
  if (!LAYER_ORDER.includes(layer)) throw new Error('未知层级：' + layer);
  return path.join(dir, LAYER_DIRNAME, layer + '.jsonl');
}

export function loadLayer(dir, layer) {
  const p = layerFileOf(dir, layer);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object' && rec.layer === layer) out.push(rec);
    } catch { /* 半行（进程被杀）不污染整个账本 */ }
  }
  return out;
}

/** 同 id 后写覆盖前写（与 impressions / store 的折叠口径一致）。 */
export function collapseLayer(records) {
  const by = new Map();
  for (const r of records) if (r && r.id) by.set(r.id, r);
  return [...by.values()];
}

/** 幂等 id：层 + 归一化文本 + 首个证据 id。同一天重跑不会写出第二条。 */
export function layerIdOf(layer, text, evidenceId) {
  return 'l_' + hashOf(layer + '\u0000' + normText(text) + '\u0000' + (evidenceId || ''));
}

function dayKeyOf(ms) {
  return fmtDayKey(ms);
}

/**
 * 从 L0 原文提炼三层记录（纯函数，不写盘）。
 *
 * @param {object[]} recs L0 记录（store.query 结果，已按 scope 单向门过滤）
 * @param {number} now
 * @returns {{fact:object[], profile:object[], lesson:object[]}}
 */
export function extractLayers(recs, now = Date.now()) {
  const facts = [];
  const lessons = [];
  const seenFact = new Map();
  const seenLesson = new Map();

  for (const rec of recs) {
    if (!rec || !rec.text) continue;
    // 只看用户说的话。AI 的回复不是关于他的事实，拿它当 L1 就是自我循环。
    if (rec.role && rec.role !== 'user') continue;
    if (rec.kind && !['msg', 'user'].includes(rec.kind)) continue;
    const scope = rec.scope || SCOPE_SHARED;
    const when = Number(rec.t) || now;
    for (const clause of splitClauses(rec.text)) {
      if (!clauseOk(clause)) continue;
      if (docish(clause)) continue;
      if (askish(clause)) continue;
      const hitF = FACT_RULES.find(function (r) { return r.re.test(clause); });
      if (hitF) {
        const key = scope + '\u0000' + normText(clause);
        const prev = seenFact.get(key);
        if (prev) {
          // 同一句话再次出现：不新增记录，把证据挂到已有的那条上（证据数才是衰减依据）。
          if (rec.id && !prev.evidenceIds.includes(rec.id)) prev.evidenceIds.push(rec.id);
        } else {
          const row = {
            id: layerIdOf('fact', clause, rec.id),
            v: LAYER_VERSION,
            layer: 'fact',
            text: clause,
            scope: scope,
            t: when,
            createdAt: now,
            source: 'user_said',
            rule: hitF.id,
            evidenceIds: [rec.id],
            generator: 'cm-consolidate/v1'
          };
          seenFact.set(key, row);
          facts.push(row);
        }
      }
      const hitL = LESSON_RULES.find(function (r) { return r.re.test(clause); });
      if (hitL) {
        const key = scope + '\u0000' + normText(clause);
        if (!seenLesson.has(key)) {
          const row = {
            id: layerIdOf('lesson', clause, rec.id),
            v: LAYER_VERSION,
            layer: 'lesson',
            text: clause,
            scope: scope,
            t: when,
            createdAt: now,
            source: 'user_said',
            rule: hitL.id,
            note: '用户原话（要求/纠正），未改写',
            evidenceIds: [rec.id],
            generator: 'cm-consolidate/v1'
          };
          seenLesson.set(key, row);
          lessons.push(row);
        }
      }
    }
  }

  // ── L2 画像：主题频次 ────────────────────────────────────────────────
  // 门槛：同一主题至少 3 次、跨至少 2 个自然日。低于门槛不写 ——
  // 一天的碎碎念不算「长期习惯」，写成画像就是给人贴标签。
  const profiles = [];
  for (const theme of PROFILE_THEMES) {
    const hits = recs.filter(function (r) {
      // 画像也排除粘贴进来的文档：整段带表格/代码/引号标记的不算他说的
      if (!r || !r.text || docish(r.text)) return false;
      return (!r.role || r.role === 'user')
        && ['msg', 'user'].includes(r.kind || 'msg') && theme.re.test(r.text);
    });
    if (hits.length < 3) continue;
    const byScope = new Map();
    for (const r of hits) {
      const sc = r.scope || SCOPE_SHARED;
      if (!byScope.has(sc)) byScope.set(sc, []);
      byScope.get(sc).push(r);
    }
    for (const entry of byScope) {
      const sc = entry[0];
      const group = entry[1];
      const gDays = new Set(group.map(function (r) { return dayKeyOf(Number(r.t) || now); }));
      if (group.length < 3 || gDays.size < 2) continue;
      const last = Math.max.apply(null, group.map(function (r) { return Number(r.t) || 0; }));
      const text = theme.name + '：最近 ' + gDays.size + ' 天提到 ' + group.length + ' 次（最近一次 ' + fmtDate(last) + '）';
      const evidence = [...new Set(group.map(function (r) { return r.id; }).filter(Boolean))].slice(0, 20);
      if (!evidence.length) continue;
      profiles.push({
        id: layerIdOf('profile', text, evidence[0]),
        v: LAYER_VERSION,
        layer: 'profile',
        text: text,
        scope: sc,
        t: last,
        createdAt: now,
        source: 'inferred',
        // 画像是统计量派生，不是某一句原话 —— 这里如实标注，别伪装成 user_said。
        rule: 'theme:' + theme.id,
        counts: { hits: group.length, days: gDays.size },
        evidenceIds: evidence,
        generator: 'cm-consolidate/v1'
      });
    }
  }

  return { fact: facts, profile: profiles, lesson: lessons };
}

// 丙方案（2026-11-21）：原文现在分两个目录（life 在本机专属目录）。
// 指纹必须两边都取，而且键要带目录前缀 —— 否则两个目录下的同名月份分片
// （2026-11.jsonl 在主目录和 life 目录各有一份）会互相覆盖掉指纹，
// 于是「life 那份被写了」这件事在 l0Unchanged 里看不出来。
function l0Fingerprint(eventsDirs) {
  const out = {};
  const dirs = Array.isArray(eventsDirs) ? eventsDirs : [eventsDirs];
  for (let i = 0; i < dirs.length; i += 1) {
    const d = dirs[i];
    if (!d) continue;
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names.filter(function (n) { return n.endsWith('.jsonl'); }).sort()) {
      try {
        const st = fs.statSync(path.join(d, name));
        out[i + ':' + name] = st.size + ':' + st.mtimeMs;
      } catch { /* 读不到就不进指纹 */ }
    }
  }
  return out;
}

function sameFingerprint(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(function (k) { return a[k] === b[k]; });
}

/**
 * 跑一轮蒸馏（cm-consolidate 的真身）。
 *
 * @param {object} opts
 * @param {string} opts.dir 记忆库目录
 * @param {object} opts.mem open() 句柄（只用 store.query，不写 L0）
 * @param {number} [opts.from] 起点毫秒（含）
 * @param {number} [opts.to] 终点毫秒（含）
 * @param {boolean} [opts.dryRun] 只算不写
 * @param {number} [opts.now]
 */
export function consolidate(opts) {
  const o = opts || {};
  const dir = o.dir;
  const mem = o.mem;
  if (!dir) throw new Error('consolidate: 缺 dir');
  if (!mem || !mem.store) throw new Error('consolidate: 缺 mem（open() 句柄）');
  const now = Number(o.now) || Date.now();
  const to = Number(o.to) || now;
  let start;
  if (Number.isFinite(Number(o.from))) start = Number(o.from);
  else {
    const d = new Date(to);
    d.setUTCHours(0, 0, 0, 0);
    start = d.getTime();
  }
  const dryRun = !!o.dryRun;
  const role = resolveRole();

  // L0 指纹：跑前跑后各取一次，用**文件大小 + mtime** 证明一个字节都没动。
  // 为什么不用行数：行数相同但内容被改写同样违反红线；size+mtime 能抓到改写。
  const eventsDir = (mem.store.eventsDir) || path.join(dir, 'raw', 'events');
  const lifeEventsDir = (mem.store.lifeEventsDir) || path.join(dir, 'raw', 'events-life');
  // 数组顺序即指纹键前缀（0=life 目录，1=主目录），跑前跑后必须用同一个顺序。
  const fingerprintDirs = [lifeEventsDir, eventsDir];
  const before = l0Fingerprint(fingerprintDirs);

  // limit:0 = 不截断。裁剪发生在过滤之后（store.js 2026-11-06 修过），所以这里安全。
  const recs = mem.store.query({ from: start, to: to, limit: 0 });
  const scanned = recs.length;
  const visible = visibleScopes(role);
  const usable = recs.filter(function (r) { return visible.includes(r.scope || SCOPE_SHARED); });
  const fresh = extractLayers(usable, now);

  const added = {};
  const counts = {};
  const written = {};
  for (const layer of LAYER_ORDER) {
    const existing = new Set(collapseLayer(loadLayer(dir, layer)).map(function (r) { return r.id; }));
    const incoming = fresh[layer].filter(function (r) { return r && r.id && !existing.has(r.id); });
    counts[layer] = fresh[layer].length;
    added[layer] = incoming.length;
    written[layer] = 0;
    if (!incoming.length) continue;
    // 越权检查放在写之前：work 侧永远不该拿到 life 记录（上游 query 已过滤，
    // 这里再挡一次是为了「万一 query 的 scope 语义改了」不至于静默污染）。
    for (const rec of incoming) assertWritable('蒸馏层级', rec.scope, dir);
    if (dryRun) continue;
    const file = layerFileOf(dir, layer);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withLock(dir, function () {
      // 锁内重读一次：两个进程同时跑，谁先拿到锁谁写，后者看到已存在就不写。
      const now2 = new Set(collapseLayer(loadLayer(dir, layer)).map(function (r) { return r.id; }));
      let n = 0;
      for (const rec of incoming) {
        if (now2.has(rec.id)) continue;
        fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
        n += 1;
      }
      written[layer] = n;
    });
  }

  const after = l0Fingerprint(fingerprintDirs);
  return {
    from: start,
    to: to,
    scanned: scanned,
    counts: counts,
    added: added,
    written: written,
    l0Unchanged: sameFingerprint(before, after),
    role: role
  };
}

/** 给 cm-consolidate --status 用：各层现有条数与日期覆盖。 */
export function layerStats(dir) {
  const out = {};
  for (const layer of LAYER_ORDER) {
    const recs = collapseLayer(loadLayer(dir, layer));
    const days = new Set(recs.map(function (r) { return dayKeyOf(Number(r.t) || 0); }));
    out[layer] = { total: recs.length, days: days.size };
  }
  return out;
}
