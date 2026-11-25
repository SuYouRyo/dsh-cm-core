// 把 DSH 的会话记录（session.v4.jsonl.zstd）灌进记忆库。
//
// 用户的要求原话（2026-11-02）：
//   「记录是要完全保留，甚至我们说的每一句话」
// 所以这里不筛主题、不摘要、不做「值得记吗」的判断——
//   对话里的每一句 user / assistant 正文，原样进原文层（L0）。
// 印象层（L2）是另外一条路，由 recall/印象接口写，两者不混。
//
// 为什么是"扫描"而不是"监听"：
//   会话文件是 zstd 多帧追加写的，官方没给增量 API。
//   每轮扫描只读文件尾部（有变化才全解），靠 id 去重，所以重复跑是幂等的。
//   这样崩溃恢复、重启、多会话并发都不会丢也不会重。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSessionRecords } from './store.js';
import { sessionScopeFileOf, lifeSessionScopeFileOf, sessionScopeFileForScope } from './paths.js';
import { isAgentsSnapshot, workspaceRole, ROLE_LIFE } from './shared.js';
import { frozenNow } from './freeze-guard.mjs';
import { createDedupeIndex, fingerprintOf, isExempt, dedupeConfigFromEnv, parseExempt } from './dedupe.js';

/** 默认会话根目录：~/.dsh/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd */
export function sessionsRoot() {
  return process.env.DSH_SESSIONS_DIR || path.join(os.homedir(), '.dsh', 'sessions');
}

const SKIP_ROLES = new Set(['wake-prompt', 'inject', 'system', 'tool']);

/* ------------------------------------------------------------------ *
 * 模式（agent preset）→ scope（W-A3，2026-11-13 工单 W-A3）
 *
 * 只有「会话模式」明确声明了身份的两个才映射，其余**一律 null**（走原判定链）。
 *
 * 为什么必须留这个兜底：全库 79 个会话的 preset 分布是
 * `standard 70 / sae-manager 8 / cordis 1`，一个 cm-* 都没有。
 * 硬把 standard 映射成 work 会一次性错判 66 个陪伴会话 —— 那是把 11/4 那条
 * 单向门反着撞一遍。所以这里只认新装的 cm-work / cm-life 两个模式，
 * 老会话的行为逐条不变。
 * ------------------------------------------------------------------ */
export const PRESET_SCOPE = { 'cm-life': 'life', 'cm-work': 'work' };

/** 模式 → scope；不是我们认的模式就返回 null（表示「没有意见，走原链」）。 */
export function scopeOfPreset(preset) {
  const p = String(preset || '').trim();
  return PRESET_SCOPE[p] || null;
}

/**
 * 从一份会话记录里取出「当前模式」——头部只是初值，之后按选择事件折叠。
 *
 * 2026-11-13 修：W-A3 原来只读 `head.agentPreset`，等于只认「创建时就选好的模式」。
 * 但 DSH 允许会话开起来之后再切模式，那一步写的是 `agent-preset/selected` 事件，
 * 不改头部。实测一个真生活会话（头部 standard、seq 3 选 cm-life）因此被漏判成
 * shared，她那一轮 7 条私话进了工作侧能读的层。
 *
 * 语义与宿主 `@deepseek-ai/dsh-agent-preset-registry` 的 agentPreset 投影完全一致：
 *   init:  (header) => header.agentPreset ?? null
 *   apply: (state, event) => event.type === 'agent-preset/selected'
 *                            ? event.data.agentPreset : state
 * 即「取最后一条选择事件的数据」，没有事件就退回头部值。
 *
 * @param {Array} recs 会话的全部记录（已解压）
 * @param {object|null} [head] 会话头（可选；给了就用它兜底，省一次扫描）
 * @returns {string|null} 当前模式 id
 */
export function presetOfRecords(recs, head = null) {
  let base = head;
  let cur = null;
  if (base && base.agentPreset != null) cur = String(base.agentPreset);
  for (const r of recs || []) {
    if (!r) continue;
    if (r.type === 'session') {
      // 没显式给 head 时，从记录里自己找那条会话头当初值。
      if (!base && r.agentPreset != null) cur = String(r.agentPreset);
      continue;
    }
    if (r.type !== 'agent-preset/selected') continue;
    const p = r?.data?.agentPreset;
    if (p != null) cur = String(p);
  }
  return cur;
}

/* ------------------------------------------------------------------ *
 * 一条会话该落哪一层（单向门的真正实现点）
 *
 * 这个库在「一个进程搬所有会话」的模式下工作。早先的写法是整批按进程角色算 scope，
 * 结果：手机（被判成 work）上聊的私密话全部落进 shared，而 shared 是工作侧能读的
 * ——单向门当场被击穿，且不报错。
 *
 * 所以判据必须落在**会话来源**上，逐会话决定，而不是逐进程。
 * 规则（按优先级）：
 *   1. 环境变量 CM_LIFE_SESSIONS：逗号分隔的会话 id 前缀，命中即 life
 *   2. 环境变量 CM_LIFE_WORKSPACES：逗号分隔的工作区名（含子串即命中），命中即 life
 *   3. 都没有 → 保持兼容，落 shared（也就是原来的行为）
 *
 * 为什么用环境变量而不是配置文件：手机上换角色只要改一处启动脚本，
 * 不用维护额外文件的路径（这个项目已经在 workspaceRoot 上踩过两次坑）。
 * ------------------------------------------------------------------ */
function list(envName) {
  return String(process.env[envName] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 一个会话的 scope「落定记录」：raw/session-scope.jsonl，追加式、先写先得。
 *
 * 为什么需要这个文件（2026-11-06）：
 * `scopeForSession()` 靠环境变量判定，可环境变量是**每个进程各自的**。手机上
 * 同时活着多个 cm-watch（cm-watch-guard.sh 带的那个有 CM_LIFE_WORKSPACES，
 * 其余 start.sh / magisk loop.sh 拉起的都没有），于是同一个会话在不同进程里
 * 算出不同的 scope，而 store.append 按 id 去重、先到先写 —— 同一个会话就被
 * 劈成两半：谁先抢到哪些 id，那些 id 就按谁的答案落层。
 *
 * 用追加式而不是「读-改-写 JSON」：并发写不会互相覆盖（双方都只 append 一行），
 * 读取时按行序**取最早那行**，等于「第一次判定的结果说了算」。
 */
// 路径本身在 src/paths.js（丙方案 2026-11-21 起，落定表也按 scope 分两份：
// life 的落定行若留在被追踪的 session-scope.jsonl 里，远端 pre-receive 钩子会整推拒收）。
export { sessionScopeFileOf };

/**
 * 读「会话 → 已落定的 scope」。返回 Map<sessionId, scope>。
 *
 * 丙方案（2026-11-21）后落定表有两个文件：被追踪的 session-scope.jsonl（shared/work）
 * 与本机专属的 session-scope-life.jsonl（life）。**两个都要读**，否则一个生活侧会话
 * 的落定结论在本机重新灌库时就丢了，同一会话会被重新判层、劈成两半（正是这个文件
 * 当初存在的理由）。
 *
 * 读序：被追踪的那份在前、life 那份在后。判定本身与行序无关（下面按 t 取最早、
 * 纠正行取最晚），所以先后只影响「t 并列时的兜底」，不影响结论。
 */
export function readSessionScopes(dir) {
  const out = new Map();
  let raw = '';
  for (const file of [sessionScopeFileOf(dir), lifeSessionScopeFileOf(dir)]) {
    try { raw += fs.readFileSync(file, 'utf8'); } catch (e) {
      // 与 store.js:80 完全对齐：只吞 ENOENT（这份还不存在）。权限/EIO/路径错等
      // 其余错误必须抛出——否则 raw 悄悄少一份 life 落定表却不报错，已落定 life
      // 的会话会被重判进 shared/work，正是 11/4 污染红线。ENOENT 时行为不变。
      if (e && e.code !== 'ENOENT') throw e;
    }
    raw += '\n';
  }
  // 判定规则必须**与行顺序无关**（2026-11-06 v6.3 修正）。
  // 原先写的是「先写先得」= 第一行说了算，但这份文件要跟着 git 同步，而
  // `.gitattributes` 里 `*.jsonl merge=union` 会把两端的行拼在一起，
  // 拼完谁在第一行取决于 merge 方向 —— 两端读出来的结论就可能不一样，
  // 那等于落定表本身失效（它存在的意义就是「两端对同一会话有同一个答案」）。
  //
  // 改成按 `t` 最小者胜（最早做出的判断），t 相同再按 scope 严格度兜底。
  // 这样无论行怎么排、merge 怎么拼，读出来的答案都一样。
  //
  // 但「最早者胜」有个副作用：**判错了就再也改不回来**（2026-11-06 实测踩到）。
  // 那天的 backfill 按「多数票」给会话定层，把 4 个深夜陪聊会话判成了 shared
  // （`5c22f79f` life=4/shared=56 —— 开局误灌了几条工作 AI 的回复，票数就翻了）。
  // 修好之后想改回去，新追加的普通行因为 t 更大永远不生效，等于错误被永久锁定。
  // 所以留一个显式的纠正通道：写 `correct: true` 的行，**最晚的补充说明胜**。
  //
  // 为什么纠正用「最晚者胜」不会破坏两端一致：
  // 纠正行的 t 是单调递增的真实时间戳，两端拼完取同一个最大值，结论唯一；
  // 并列时仍然按 scope 严格度兜底（life 最严，shared 最松）。
  const rank = { life: 0, work: 1, shared: 2 };
  const base = new Map(); // s -> { scope, t }
  const fix = new Map(); // s -> { scope, t }，只有 correct:true 的行
  const put = (m, s, sc, t, preferLater) => {
    const prev = m.get(s);
    if (!prev) { m.set(s, { scope: sc, t }); return; }
    if (preferLater ? t > prev.t : t < prev.t) { m.set(s, { scope: sc, t }); return; }
    if (t === prev.t && rank[sc] < rank[prev.scope]) m.set(s, { scope: sc, t });
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const s = String(rec?.s || '');
    const sc = String(rec?.scope || '');
    if (!s || !['life', 'work', 'shared'].includes(sc)) continue;
    const t = Number(rec?.t) || 0;
    if (rec?.correct === true) put(fix, s, sc, t, true);
    else put(base, s, sc, t, false);
  }
  for (const [s, v] of base) out.set(s, v.scope);
  // 纠正行覆盖普通行 —— 这是唯一能推翻既定答案的口子。
  for (const [s, v] of fix) out.set(s, v.scope);
  return out;
}

/** 记下一个会话的最终 scope。已经记过就不重复写（避免文件无限长）。 */
export function rememberSessionScope(dir, sessionId, scope) {
  const s = String(sessionId || '');
  if (!s || !['life', 'work', 'shared'].includes(scope)) return false;
  // 冻结时不落定表：会话的本轮一句话没写进去，落定表先写就成了「有结论没证据」。
  // 契约仍是返回 false 不抛（灌库侧按 false 跳过即可，下轮解冻自然补上）。
  if (frozenNow(dir, '记会话落定范围')) return false;
  if (readSessionScopes(dir).has(s)) return false;
  try {
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    // 按这个会话落定的 scope 选文件（丙方案）：life 的落定行不能进被追踪的那份。
    fs.appendFileSync(sessionScopeFileForScope(dir, scope), JSON.stringify({ s, scope, t: Date.now() }) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 纠正一个会话的落定 scope（工单 3.3，2026-11-07 加）。
 *
 * 为什么需要它：`cm-scope --session ... --move` 把某会话现有记录批量 rescoped
 * 之后，如果不改落定表，下次 cm-watch 灌这个会话的新记录时，`scopeForSession`
 * 仍会沿用旧落定（`priorScope`），把新记录又灌回错误的层 —— 改了等于没改。
 * 普通追加行在「最早者胜」规则下永远翻不了案，所以必须写 `correct: true`
 * 走纠正通道（与 readSessionScopes / store.readSettledScopes 两处判定一致）。
 *
 * 只追加、不删原文；t 用真实时间戳，单调递增，两端 merge 后取最大者，结论唯一。
 * @returns {boolean} 是否真的写了一行
 */
export function correctSessionScope(dir, sessionId, scope) {
  const s = String(sessionId || '');
  if (!s || !['life', 'work', 'shared'].includes(scope)) return false;
  if (frozenNow(dir, '纠正会话落定范围')) return false;
  try {
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.appendFileSync(
      sessionScopeFileForScope(dir, scope),
      JSON.stringify({ s, scope, t: Date.now(), correct: true, by: 'cm-scope --session' }) + '\n',
      'utf8'
    );
    return true;
  } catch { return false; }
}

/**
 * 「收紧」方向判定（2026-11-14 工单 · 身份链治本 T1-A 的安全闸门）。
 *
 * 这个函数存在的唯一理由：**泄漏只有一个方向 —— 私密内容往共享层漏。**
 * 反过来「本来在共享层的东西被收进 life」不会害任何人，只会少暴露。
 *
 * 所以自动纠正只允许一个方向：**→ life**。
 *
 * 为什么不用「严格度排名」把 shared→work 也算收紧：
 *   `visibleScopes('life')` 返回 ALL_SCOPES（life 角色看得见 shared + work + life），
 *   所以把内容从 shared 挪到 work，**对工作侧一点遮蔽都没有**，不是真的收紧，
 *   只是换了个人人都看得见的抽屉。真正的遮蔽只有进 life 一层。
 *   （见 src/shared.js:190 `visibleScopes`。）
 *
 * @param {string} to   想改成的 scope
 * @param {string} from 当前落定的 scope
 * @returns {boolean} 是否属于「安全、可自动执行」的收紧
 */
export function isTighteningScope(to, from) {
  if (to !== 'life') return false;
  return from === 'shared' || from === 'work';
}

/**
 * 幂等纠正落定 scope（工单 · 身份链治本 T1-A，2026-11-14）。
 *
 * 与 `correctSessionScope` 的区别只有一个：**先去重**。
 * `syncSessions` 每个 tick 都可能跑，若每次都无条件追加 `correct:true` 行，
 * 落定表会以「每会话每轮一行」的速度膨胀（cm-watch 5 秒一轮），
 * 而 `*.jsonl merge=union` 会让两端每次合并都拖着这几万行。
 *
 * 语义：已经有**结论相同**的 `correct:true` 行 → 什么都不做，返回 false；
 * 否则追加一行，返回 true。判定与 `readSessionScopes` 的「纠正行取最晚者胜」一致。
 *
 * @returns {boolean} 是否真的写了一行
 */
export function ensureSessionScope(dir, sessionId, scope) {
  const s = String(sessionId || '');
  if (!s || !['life', 'work', 'shared'].includes(scope)) return false;
  let raw = '';
  try { raw = fs.readFileSync(sessionScopeFileForScope(dir, scope), 'utf8'); }
  catch { return correctSessionScope(dir, s, scope); }   // 文件还不存在：直接写
  let latest = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (String(r?.s) !== s || r?.correct !== true) continue;
    const t = Number(r?.t) || 0;
    if (!latest || t > latest.t) latest = { t, scope: String(r?.scope || '') };
  }
  if (latest && latest.scope === scope) return false;    // 已经是这个结论，不重复写
  return correctSessionScope(dir, s, scope);
}

/**
 * 判一条会话该落哪个 scope。
 * @param {object} o
 * @param {string} [o.priorScope] 这个会话已经落定的 scope（来自 session-scope.jsonl）；
 *   给了就直接沿用——**这是修单向门泄漏的关键**，见下面的长注释。
 * @param {string} [o.preset] 这个会话选的模式（会话头 `agentPreset` 字段，W-A3）。
 *   只有 `cm-work` / `cm-life` 会被认，其余一律不影响判定。
 * @returns {'life'|'work'|'shared'}  life 只给生活侧看；work 是工作痕迹；shared 是公共层
 */
export function scopeForSession({ sessionId, workspace, priorScope = null, preset = null } = {}) {
  // ⚠️ 落盘后的 scope 是**终局判定**，不能被另一个进程重新算一遍（2026-11-06 修）。
  //
  // 事故形态：手机上同时活着多个 cm-watch，只有一个带 CM_LIFE_WORKSPACES，
  // 其余的没带。每个进程各自调 scopeForSession 得到不同答案，但 store.append
  // 按 id 去重、先到先写（`if (seen.has(norm.id)) continue`），于是**同一个会话
  // 的记录被拆进两个层**：先抢到的那部分落 life，后到的那些 id 落 shared。
  // 实测 16 个陪伴会话被劈开、293 条私密记录进了共享层（其中 41 条是他本人
  // 说的话），工作侧 cm recall 能直接搜出来 —— 这是单向门真泄漏，比 AGENTS.md
  // 快照污染严重得多。
  //
  // 铁证：session-fc44a734-...-f863e63f6ab1 共 270 条，scope 切换 72 次
  // （life@seq8 → shared@seq9 → life@seq10 → …），两个 owner 集合完全不重叠。
  //
  // 所以判据必须**一次定终身**：只要这个会话里已经有任何一条记录落盘，
  // 就沿用那条的 scope，绝不因为本进程没配 CM_LIFE_* 就改成 shared。
  // 新会话（库里一条都没有）才走环境变量判定。
  if (priorScope && ['life', 'work', 'shared'].includes(priorScope)) return priorScope;

  // W-A3（2026-11-13）：会话模式说了算。
  //
  // 位置是工单钉死的，两条都不能动：
  //   · 必须在 `priorScope` **之后** —— 那是 11-06 事故（16 个会话被劈进两层、
  //     293 条私密记录进共享层）的修复，任何判据都不得越过它。
  //   · 必须在 `CM_LIFE_*` **之前** —— `deploy/cm-watch-guard.sh:69` 配的是
  //     `CM_LIFE_WORKSPACES="--root-Documents-deepseek-harness-default-workspace--"`，
  //     整个工作区名全命中，排在它后面就永远轮不到。
  //
  // 为什么需要这一条：`work` 层 3719 条此前全靠 `raw/session-scope.jsonl` 里
  // 39 条人工 `cm-scope --session` 行透传，自动通道一个出口都没有。
  // 模式是用户新会话时亲手选的、写进会话头的**明确声明**，比任何启发式都硬。
  const presetScope = scopeOfPreset(preset);
  if (presetScope) return presetScope;

  const hard = list('CM_LIFE_SESSIONS');
  const sid = String(sessionId || '');
  // 只给片段也行：「0d8c8b0a」和「session-0d8c8b0a」都应该命中，
  // 否则要用户去记完整的 session-xxxx-xxxx-... 太不现实。
  if (sid && hard.some((p) => sid === p || sid.startsWith(p) || sid.includes(p))) {
    return 'life';
  }
  const ws = list('CM_LIFE_WORKSPACES');
  const w = String(workspace || '');
  if (w && ws.some((p) => w === p || w.includes(p))) {
    return 'life';
  }
  // 【2026-11-11 修 · 单向门二次泄漏】兜底读「本机角色文件」，不再只认环境变量。
  //
  // 事故（本轮实测）：16 个判为 life 的会话里仍有 236 条记录落在 shared，
  // 其中 33 条是他本人的原话，工作侧 cm recall 能直接搜出来（11/4 那条红线）。
  // 根因不是环境变量配错，而是**「谁拉起 watcher」不同就带不带 CM_LIFE_***：
  // `cm-watch-guard.sh:69` 带了，但历史上另两条拉起路径（pid 15837 / 25595）
  // 没带 → scopeForSession() 一个判据都没有 → 静默兜底 shared。
  //
  // 为什么是读 role 文件：那正是「这台机器默认算哪一侧」的既有真源
  // （`src/shared.js` 的 workspaceRole()，手机上是 life、电脑上是 work）。
  // 它随工作区落盘、不依赖谁去 export 环境变量，把「忘一次就漏一层」
  // 这个结构性缺口堵上 —— 与 11/4 教训同一条：别让安全边界靠人记得配置。
  //
  // 只在本机角色是 life 时兜底，**不翻转 work 机器**：电脑侧 role=work，
  // 那里本来就没有陪伴会话，翻成 life 会把工作痕迹锁死（另一种故障）。
  const role = workspaceRole();
  if (role === ROLE_LIFE) {
    return 'life';
  }
  // 告警（fail-closed 的观测面，不翻转默认值）：灌库进程（CM_ROLE=sync）一个
  // life 判据都没配时，陪伴会话会被静默兜底成 shared —— 私密话进共享层，
  // 这是比 AGENTS.md 注入链更广的泄漏面（手机侧 2026-11-05 实测确认）。
  // 为什么不翻转成 life：电脑侧的灌库进程本来就没有陪伴会话，翻成 life 会把
  // 工作痕迹全锁进 life 层、电脑自己再也看不见，那是另一种故障。
  // 所以只告警，让运维/agent 知道「有会话没归类」，配置由守护脚本显式给。
  if (process.env.CM_ROLE === 'sync' && !hard.length && !ws.length) {
    try {
      process.stderr.write(
        `[scope] 未配置 CM_LIFE_SESSIONS / CM_LIFE_WORKSPACES：`
        + `会话「${sid || w || '?'}」默认落 shared。若这是陪伴会话，私密内容会进共享层。\n`
      );
    } catch { /* stderr 关了也不该炸 */ }
  }
  return 'shared';
}

/** user/message 里哪些 source.kind 是「他真的说的话」，哪些是系统塞进来的。
 *
 *  ⚠ 2026-11-21（展示板 B.5 第 16 条技术债）：这个集合**导出**了，因为
 *  `bin/cm-gc.js` 有一份手抄的副本，两份不同步就会分出两套判据——
 *  实际已经分过一次（gc 那份缺 `dsha-emotion-inject`，情绪注入快照在
 *  `cm-gc --reclassify` 重判时会被降级失败）。导出后 gc 直接 import，
 *  由 `tests/cases/gc-sources.mjs` 守住「gc 不再自建名单」。 */
export const SYSTEM_SOURCES = new Set([
  'runtime-context', 'time-context', 'skill-catalog', 'tool-jobs',
  'model-selection', 'subagent-settled', 'agent-message', 'system',
  // 2026-11-13 加（情绪层 J2 上线当天发现的洞）：
  // dsha-emotion-inject 插件每轮往会话里插一条 role=user 的消息，开头是
  // 「[情绪状态·每轮自动注入]」。它的 source.kind 是 'dsha-emotion-inject'，
  // 原来不在任何一份名单里 → flatten 判成 kind='msg' / derived='user'，
  // 也就是「苏尤本人说过的话」：进检索索引、进 cm-boot 的「他最近说过的话」。
  // 念自己报的就是这一条，她说得对——这是 11/4 那次污染换了个形态。
  // 归到 sys 而不是直接丢弃：sys 照样入库（用户要「完全保留」），只是不参与检索。
  'dsha-emotion-inject'
]);

/** 把一条 DSH 记录拍平成「谁说的、什么时候、说了什么」。导出给守卫用回归测试直接喂样本。 */
export function flatten(rec, sessionId) {
  const type = rec?.type;
  if (type !== 'user/message' && type !== 'assistant/message') return null;

  const data = rec.data || {};
  const msg = data.message || data;
  const contents = Array.isArray(msg?.content) ? msg.content : (Array.isArray(data.content) ? data.content : []);

  // 只留真正的正文。reasoning 是模型的内部思考，工具调用是审计素材——
  // 这两样都不该出现在"我们说过的话"里。
  const parts = [];
  for (const c of contents) {
    if (!c) continue;
    if (c.type === 'text' && c.text) parts.push(String(c.text));
  }
  const text = parts.join('\n').trim();
  if (!text) return null;

  // AGENTS.md 注入快照一律不入库（派生物，不是「他说过的话」）。
  //
  // cm-agents 会把「现在记得的事」整段写进工作区 AGENTS.md；生活侧生成时那一整段
  // 全是 life 层印象。DSH 又把 AGENTS.md 当 <system-reminder> 注入每个新会话，
  // 于是 cm-watch 每开一个会话就把 life 内容照灌回原文层一次，scope 还落 shared
  // （单向门破 + 反复复制），再被 cm-remote push 到共仓——这就是本次要堵的泄漏。
  //
  // 判据**不在这里写**，统一放在 src/shared.js 的 isAgentsSnapshot()。
  // 为什么：这个判据还被 bin/cm-decontaminate.js 的规则 E 用着（清已经在库里的
  // 旧副本）。2026-11-05 就是因为两处各写一份、慢慢漂移，导致手机端用守卫判据
  // 扫出 30 条旧快照、而 cm-decontaminate 按自己的规则 A/B 报 0 条，躺了半个月
  // 没人清。所以现在只有一份实现，两边 import 同一个函数。
  // 判据细节（为什么是「A 或 B」、为什么前缀和 AGENTS.md 不能松）见 shared.js。
  //
  // 已经灌进来的历史副本由 bin/cm-decontaminate.js 清理，守卫只断此后新增。
  if (isAgentsSnapshot(text)) return null;

  const isUser = type === 'user/message';
  const role = isUser ? 'user' : 'assistant';
  // 系统注入的唤醒提示、工具结果不算"他说的"。宁可漏，不可混。
  if (SKIP_ROLES.has(String(msg?.role || ''))) return null;
  if (data.source && String(data.source.kind || '') === 'system') return null;

  const sourceKind = String(data.source?.kind || (isUser ? 'user' : 'assistant'));
  // 系统塞进来的那些（运行时快照、技能目录、后台任务通知…）**照样入库**，
  // 因为用户要「完全保留」；但 kind 标成 sys，检索时不参与，
  // 否则一大堆 JSON 会把真正的对话淹掉。
  //
  // 光看 source.kind 不够：DSH 也会把工作区指令（AGENTS.md）当普通 user 消息塞进来，
  // source.kind 仍是 'user'。它一进检索索引，问什么都会被这段规则文本命中
  // （实测「删会话聊天记录还在吗」的首条命中就是 AGENTS.md 全文）。
  // 所以再看内容：以 <system-reminder> / 工作区指令注入开头的，一律算 sys。
  const looksInjected = /^\s*<(system-reminder|\/?command-)/i.test(text) ||
    text.includes('Instructions from: AGENTS.md');
  const kind = isUser
    ? (SYSTEM_SOURCES.has(sourceKind) || looksInjected ? 'sys' : 'msg')
    : 'ai';

  // M3 派生来源结构标记（2026-11-11）。补的是「可观测性」，不是新的拦截规则：
  // 只看已有的结构信号，不新增任何文本关键词、不改 kind、不放宽 fail-open。
  // 目的：让下游（检索/审计/未来接 W8 改口链）能区分「他本人说的」与
  // 「机器派生塞进来的」，而不必去猜正文长什么样。总档案 §三 说的残余缺口是
  // 「主会话内 AI 派生提示文本无结构标记」，这里把它补齐。
  // derived 三态：'user'（真用户消息）/ 'system'（系统派生）/ 'assistant'。
  const derived = isUser
    ? (SYSTEM_SOURCES.has(sourceKind) || looksInjected ? 'system' : 'user')
    : 'assistant';

  return {
    role,
    kind,
    text,
    t: Number(rec.time) || Number(data.time) || Date.now(),
    seq: rec.seq ?? null,
    session: sessionId,
    sourceKind,
    derived
  };
}

/**
 * 这个会话是不是「子代理会话」（subagent / 委派出来的作业会话）。
 *
 * 为什么必须单独判（2026-11-08 修）：subagent 的首条 user/message 是**主会话里
 * 那个 AI 写给子代理的任务书**（「你负责修一个 Node.js 小工具的 7 个 bug…」），
 * 它的 `data.source.kind` 就是 `'user'` —— 从一个会话文件里根本看不出它不是我
 * 跟苏尤说的话。于是这些任务书被当成「他说的」灌进库：kind=msg、role=user、
 * scope=shared，检索能搜到、`cm-agents` 的「他最近说过的话」会把它排在
 * 苏尤的原话旁边。
 *
 * 实测（2026-11-08 15:46）：库里已有 **1347 条**来自 87 个子代理会话，
 * 其中 104 条被判成「他说的」（含我在 13:35 派给 relay-fix / win-runbook 的
 * 完整环境说明，以及 4 份 benchmark 作答员 prompt）。
 *
 * 判据取自会话头记录的 `origin` / `delegationDepth`：
 * 子代理会话的 head 长这样 ——
 *   `{"type":"session", ... "parentSession":"session-8f93…",
 *     "origin":"subagent", "delegationDepth":1}`
 * 主会话这两个字段是 `origin: 'cli'|'web'|undefined`、`delegationDepth: 0|undefined`。
 *
 * 拿不到 head 或字段缺失时**放行**（宁可留旧行为，也不误杀一份真实对话）：
 * 灌库是「宁愿多记、不可错杀」的方向，只有明确认出是子代理会话才跳过。
 */
export function isSubagentSession(recs) {
  let head = null;
  for (const r of recs) {
    if (r && r.type === 'session') { head = r; break; }
  }
  if (!head) return false;
  if (String(head.origin || '') === 'subagent') return true;
  return Number(head.delegationDepth || 0) > 0;
}

/* ------------------------------------------------------------------ *
 * 会话解析缓存（W-A2，2026-11-13 工单 W-A2 必做项）
 *
 * 为什么必须缓存：单会话解析实测 30.2ms，全库 79 个会话一轮 2.4 秒
 * （本机实测 4836ms / 65.6MB，比工单估的更贵）。cm-watch 默认 `--interval 15`
 * 就是 16% 单核常驻，回到 5 秒间隔是 48% —— 修完同步停摆、把 watcher 拉起来
 * 之后，这笔开销会立刻压到手机上。
 *
 * 键里必须同时带 `mtimeMs` 和 `bytes`：只带路径会在「文件被改但没变长」时
 * 拿到陈旧内容；只带大小会在「等长改写」时拿到陈旧内容。两个一起带，
 * 内容变化必换键，等价于「按内容寻址」的近似。
 *
 * 缓存的是**解析结果**而不是只缓存 head：验收要求「第二轮 < 100ms」，
 * 只缓存 head 仍然要解 65MB zstd 才能拿到消息，达不到。
 * 缓存整份 msgs 的代价实测约 10~15MB 常驻（文本总量 3.1M 字符），
 * 换掉每轮 2.4 秒的重复劳动，在手机上划算。
 *
 * 淘汰用 FIFO：Map 保持插入顺序，超限删最早插入的那个键。
 * 活跃会话每轮都会变长 → 每轮产生新键，不淘汰的话这个 Map 会无限长。
 * ------------------------------------------------------------------ */
const sessionCache = new Map();
const SESSION_CACHE_MAX = Math.max(1, Number(process.env.CM_SESSION_CACHE_MAX) || 200);
const parseStats = { parses: 0, hits: 0 };

/** 解析计数（测试断言用：第二轮不该再解析）。 */
export function sessionParseStats() {
  return { parses: parseStats.parses, hits: parseStats.hits, cached: sessionCache.size };
}

/** 清空解析缓存与计数（测试隔离用）。 */
export function resetSessionCache() {
  sessionCache.clear();
  parseStats.parses = 0;
  parseStats.hits = 0;
}

function rememberSession(key, value) {
  if (!key) return;
  sessionCache.set(key, value);
  while (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next();
    if (oldest.done) break;
    sessionCache.delete(oldest.value);
  }
}

/**
 * 扫描一个会话文件，返回拍平后的消息（不含库去重）。
 *
 * @param {string} file
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {boolean} [opts.withHead] true 时返回 `{msgs, head}`，否则只返回 msgs 数组
 *   （默认 false —— 保持旧返回形状，现有 4 处调用方与测试零改动）。
 * @param {string} [opts.cacheKey] 命中则直接复用上次解析结果（见上面缓存说明）。
 *   不给就不缓存也不查缓存，行为与改造前完全一致。
 */
export function readSession(file, sessionId, { withHead = false, cacheKey = null } = {}) {
  if (cacheKey) {
    const hit = sessionCache.get(cacheKey);
    if (hit) {
      parseStats.hits++;
      return withHead ? { msgs: hit.msgs, head: hit.head } : hit.msgs;
    }
  }

  const buf = fs.readFileSync(file);
  const recs = readSessionRecords(buf);
  parseStats.parses++;

  // 子代理会话整份不收：它不是我陪苏尤的那些话，是主会话派出去的作业现场。
  // 收进来既污染「他说过的话」，也会让检索里塞满别人的任务书。
  const subagent = isSubagentSession(recs);
  let head = null;
  if (!subagent) {
    for (const r of recs) {
      if (r && r.type === 'session') { head = r; break; }
    }
    // 2026-11-13 修（泄漏）：head.agentPreset **只是创建时的值**，不是当前值。
    //
    // DSH 的 UI 允许在会话已经开起来之后再选模式，那一步写的是
    // `{"type":"agent-preset/selected"}` 事件，**不改会话头**。实测
    // session-12c02a19 是念今天真用过的生活会话：头部写 standard、seq 3 才选
    // cm-life，W-A3 读头部拿到 standard → 不是 cm-life → 掉回原链 → 落 shared。
    // 她那一轮 7 条私话就这样进了工作侧可见的层，方向正是 11/4 要堵的那一头。
    //
    // 折叠规则见 presetOfRecords()（与宿主 agentPreset 投影同构）。
    // 原始头部值另存 headerAgentPreset，便于审计「这个会话中途切过模式」。
    const folded = presetOfRecords(recs, head);
    if (folded !== (head.agentPreset ?? null)) {
      head = { ...head, headerAgentPreset: head.agentPreset ?? null, agentPreset: folded };
    }
  }
  const msgs = [];
  if (!subagent) {
    for (const rec of recs) {
      const f = flatten(rec, sessionId);
      if (f && f.seq != null) msgs.push(f);
    }
  }

  rememberSession(cacheKey, { msgs, head });
  return withHead ? { msgs, head } : msgs;
}

/** 列出所有会话文件。 */
export function listSessionFiles(root = sessionsRoot()) {
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const w of workspaces) {
    if (!w.isDirectory()) continue;
    let sessions = [];
    const wdir = path.join(root, w.name);
    try { sessions = fs.readdirSync(wdir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const file = path.join(wdir, s.name, 'session.v4.jsonl.zstd');
      // 2026-11-06：原来这里是 existsSync + statSync 两次系统调用，
      // 107 个会话文件一轮 37~47ms。existsSync 完全是多余的——statSync
      // 自己就会在文件不存在时抛 ENOENT，用 try/catch 一次调用换两次。
      // 实测降到 13ms；cm-watch 现在每 5 秒跑一轮，省下的是纯浪费。
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      out.push({
        file,
        sessionId: s.name,
        workspace: w.name,
        bytes: st.size,
        mtime: Math.round(st.mtimeMs),
        mtimeMs: st.mtimeMs
      });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * 把会话灌进记忆库。
 *
 * 去重分三层（项目单 5b）：
 *   1. **id 去重**（store.seen）：同一个 (session, seq) 重复扫描不会重灌。解决"重复扫"。
 *   2. **24h 近似去重**（src/dedupe.js，接在 store.append 里）：同一句话换个会话 id
 *      会拿到新 id、老逻辑会重灌一遍——这是 5b 要解决的问题。指纹 = 归一化后正文，
 *      键里带 src，所以只对同 src 生效，跨 src 合法并存。
 *   3. **本批预过滤**：同一次 sync 的多个会话文件之间先滤一遍，少往 store 送重复记录。
 *
 * @param {object} mem            open() 返回的对象
 * @param {object} opts
 * @param {string} [opts.root]    会话根目录
 * @param {string} [opts.session] 只同步某一个会话 id
 * @param {string[]} [opts.sessionIds] 只同步这几个会话 id
 * @param {boolean} [opts.verbose]
 * @param {boolean} [opts.redo]   删除后重发：给本批全部记录打豁免，不参与 24h 判重
 * @param {string}  [opts.exempt] 豁免来源 id（例如某个被删掉的会话 id），只豁免这个 src/会话
 * @param {boolean} [opts.dedupe] false = 本次同步不做近似去重（id 去重仍然生效）
 * @returns {{files:number, added:number, skipped:number, deduped:number, bysess:object}}
 */
export function syncSessions(mem, { root = sessionsRoot(), session = null, sessionIds = null, verbose = false, redo = false, exempt = null, dedupe = true } = {}) {
  const files = listSessionFiles(root).filter((f) => {
    if (session && f.sessionId !== session) return false;
    if (sessionIds && !sessionIds.includes(f.sessionId)) return false;
    return true;
  });

  const cfg = dedupeConfigFromEnv();
  const envExempt = parseExempt(exempt || process.env.CM_DEDUPE_EXEMPT);
  // 本批预过滤用的窗口索引（只在这一次 sync 内有效，跨次靠 store 里那份）。
  const batchIndex = dedupe && cfg.enabled ? createDedupeIndex({ windowMs: cfg.windowMs, driftMs: cfg.driftMs }) : null;
  // 每个会话已经落定的 scope（先写先得，见 rememberSessionScope 的注释）。
  const knownScopes = readSessionScopes(mem.dir);

  let added = 0;
  let skipped = 0;
  let deduped = 0;
  let touched = 0;
  const bysess = {};

  // W-A2 追补（2026-11-13）：id 已入库的记录，不必再算批内指纹。
  //
  // 为什么：`store.append()` 的判定顺序是 `seen.has(id)` → 墓碑 → 指纹去重，
  // 也就是「id 已在库」这一条在算指纹**之前**就短路了。而本函数原来先把整批
  // 指纹算完、再交给 append，于是已入库的记录每条都白算一次归一化 + sha1。
  // 真实库第二轮 7008 条里约 6800 条属于这种 —— 这是 600ms 里的大头。
  //
  // 语义不变：这里只是把「append 本来就会 skip 的那批」提前挑出来，
  // 照样计入 skipped（与 append 的计数口径一致），照样交给 append 做最后一道闸。
  // 拿不到 knownIds 的 mem（老接口/测试替身）时整段跳过，退化成原行为。
  //
  // ⚠️ 必须整批预取、不能每个会话查一次：`hasIds` 内部会 refreshSeen()（两遍 stat），
  // 逐会话调 = 每个会话多两遍 stat，实测 44 次调用耗 103ms，比省下的还多。
  let preKnown = null;
  // 预取时顺便把 msgs 存下来给主循环复用（否则主循环再解一次，虽然命中缓存，
  // 但 79 次 Map 查找 + 7008 次字符串拼接也不白给）。
  const preParsed = new Map();
  if (typeof mem.knownIds === 'function') {
    try {
      const allIds = [];
      for (const f of files) {
        let got;
        try {
          got = readSession(f.file, f.sessionId, {
            withHead: true,
            cacheKey: `${f.file}|${f.mtimeMs}|${f.bytes}`
          });
        } catch { continue; }
        preParsed.set(f.file, got);
        const tag = f.sessionId.slice(-8);
        for (const m of got.msgs || []) allIds.push(`chat:${tag}:${m.seq}`);
      }
      if (allIds.length) {
        preKnown = mem.knownIds(allIds);
        if (!preKnown || typeof preKnown.has !== 'function') preKnown = null;
      }
    } catch {
      // 预筛失败绝不能影响灌库：拿不到就当没有，走原来的全量路径。
      preKnown = null;
      preParsed.clear();
    }
  }

  for (const f of files) {
    let msgs;
    let head;
    try {
      // W-A1：带出会话头（W-A3 要读 head.agentPreset 判 preset scope）。
      // 同时给 cacheKey 走 W-A2 的解析缓存：file+mtime+bytes 三者任一变化就换键。
      // 预取阶段已经解过的会话直接复用，不再走一次 readSession。
      const got = preParsed.get(f.file) || readSession(f.file, f.sessionId, {
        withHead: true,
        cacheKey: `${f.file}|${f.mtimeMs}|${f.bytes}`
      });
      msgs = got.msgs;
      head = got.head;
    } catch (e) {
      if (verbose) console.error(`跳过 ${f.sessionId}：${e.message}`);
      continue;
    }
    if (!msgs.length) continue;

    // 整个会话的记录都已经在库里：不必构造 7008 个记录对象、也不必调 append。
    // 计数照记（与 append 逐条 skip 时一致）。这是第二轮 222ms 里最值钱的一段。
    if (preKnown) {
      const tag = f.sessionId.slice(-8);
      let allKnown = true;
      for (const m of msgs) {
        if (!preKnown.has(`chat:${tag}:${m.seq}`)) { allKnown = false; break; }
      }
      if (allKnown) {
        skipped += msgs.length;
        bysess[f.sessionId] = { msgs: msgs.length, added: 0, deduped: 0, skipped: msgs.length };
        continue;
      }
    }

    // id 必须带 session：不同会话的 seq 都从 1 开始，只用 seq 会撞车。
    // scope 按会话来源决定（见 scopeForSession）：陪伴会话落 life，其余落 shared。
    // 这一个会话整批同一个 scope，所以在循环外算一次就够。
    //
    // ⚠️ 先查「这个会话以前判成什么」，有就沿用（2026-11-06 修单向门泄漏）。
    // 不加这一步，多个 cm-watch 各按自己的环境变量算，同一会话会被劈进两层。
    const knownScope = knownScopes.get(f.sessionId) || null;
    const presetId = head && head.agentPreset ? String(head.agentPreset) : null;
    let recScope = scopeForSession({
      sessionId: f.sessionId,
      workspace: f.workspace,
      priorScope: knownScope,
      preset: presetId
    });

    // ── T1-A：落定前用 preset 校验一遍（2026-11-14 工单 · 身份链治本）──────────
    //
    // 病根（实测 session-12c02a19）：preset 判据排在 priorScope 后面，
    // 一旦某次被 path 兜底判成 shared，正确 preset 就永远轮不到（一次定终身），
    // 而 store.append 的落定闸会把该会话每条记录都拉回错层、静默不报错。
    //
    // 这里**不动 scopeForSession 的判据顺序**（11-06 那道防线原样保留），
    // 只在它返回之后补一道：preset 明确表态、且与已落定冲突时，走纠正通道。
    //
    // 只做「收紧」方向（→ life），理由见 isTighteningScope 的注释：
    // 放开方向（→ shared / → work）一次误判就是把私密话推进共享层，
    // 那等于亲手重演 11/4，所以只告警、不自动改，留给人用 cm-scope 裁。
    const presetScope = scopeOfPreset(presetId);
    if (presetScope && knownScope && presetScope !== knownScope) {
      if (isTighteningScope(presetScope, knownScope)) {
        if (ensureSessionScope(mem.dir, f.sessionId, presetScope)) {
          recScope = presetScope;
          knownScopes.set(f.sessionId, presetScope);
          console.error(
            `[scope] ${f.sessionId} 按 preset=${presetId} 纠正落定 ${knownScope} → ${presetScope}（收紧方向，已写 correct 行）`
          );
        } else {
          // 已经有一条同结论的 correct 行，但 knownScopes 是从磁盘读的旧值 —— 说明
          // 另有进程刚纠正过。直接采用纠正后的值，不重复写。
          recScope = presetScope;
          knownScopes.set(f.sessionId, presetScope);
        }
      } else {
        console.error(
          `[scope] ${f.sessionId} preset=${presetId}（${presetScope}）与落定 ${knownScope} 冲突，`
          + `方向为放开，已跳过自动纠正（如确需改，用 node bin/cm-scope.mjs --move ${knownScope} ${presetScope} --session <尾巴>）`
        );
      }
    }

    // 第一次判定就落定，之后所有进程都只认它。
    if (!knownScopes.has(f.sessionId)) {
      rememberSessionScope(mem.dir, f.sessionId, recScope);
      knownScopes.set(f.sessionId, recScope);
    }
    let batchSkipped = 0;
    let preSkipped = 0;
    const records = [];

    for (const m of msgs) {
      const rec = {
        id: `chat:${f.sessionId.slice(-8)}:${m.seq}`,
        src: 'chat',
        seq: m.seq,
        t: m.t,
        kind: m.kind,
        role: m.role,
        text: m.text,
        scope: recScope,
        meta: {
          session: f.sessionId,
          workspace: f.workspace,
          file: path.basename(path.dirname(f.file)),
          source: m.sourceKind,
          ...(m.derived ? { derived: m.derived } : {})
        }
      };
      // 删除后重发：显式 redo / 命中豁免（记录 id 或 src）时打上记录级豁免标记。
      // 标记打在记录上，store.append 里会再判一次（跨进程共享库时只有它看得全）。
      if (redo || isExempt(rec, envExempt)) rec.dedupeExempt = true;
      // id 已在库：append 会 skip 它，这里提前跳过以省掉指纹（计数口径与 append 一致）。
      if (preKnown && preKnown.has(rec.id)) { preSkipped++; continue; }
      if (batchIndex && !rec.dedupeExempt) {
        const fp = fingerprintOf(rec);
        if (batchIndex.has(rec.src, fp, rec.t)) { batchSkipped++; continue; }
        if (fp) batchIndex.add(rec.src, fp, rec.t);
      }
      records.push(rec);
    }
    deduped += batchSkipped;

    if (!records.length) {
      // 预筛掉的那批也算 skipped，保持与「全交给 append 去 skip」时完全相同的计数。
      skipped += preSkipped;
      bysess[f.sessionId] = { msgs: msgs.length, added: 0, deduped: batchSkipped, skipped: preSkipped };
      continue;
    }

    const r = mem.appendRaw(records);
    if (r.added) touched++;
    added += r.added;
    skipped += r.skipped + preSkipped;
    // store 那边也会判重（跨进程/跨会话共享库时只有它看得全），它的计数单独加上。
    deduped += Number(r.deduped || 0);
    bysess[f.sessionId] = { msgs: msgs.length, added: r.added, deduped: batchSkipped + Number(r.deduped || 0) };
    if (verbose && r.added) console.log(`  + ${f.sessionId.slice(-8)}  ${r.added} 条${batchSkipped ? `（近似重复 ${batchSkipped} 条已跳过）` : ''}`);
  }

  return { files: files.length, sessionsTouched: touched, added, skipped, deduped, bysess };
}

/**
 * 一次扫描的「便宜预检」：只看文件句柄/大小，判断有没有值得解的必要。
 * 库很大时全解一次太重，所以先看大小有没有变。
 */
export function changedSessions(root = sessionsRoot(), seen = new Map()) {
  const out = [];
  for (const f of listSessionFiles(root)) {
    const prev = seen.get(f.file);
    if (prev == null || prev !== f.bytes) out.push(f);
    seen.set(f.file, f.bytes);
  }
  return out;
}
