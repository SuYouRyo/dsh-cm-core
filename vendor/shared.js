// 多 AI / 多会话共享同一个记忆库。
//
// 场景：工作区里同时开着好几个 DSH 会话（也可能是不同的 agent preset），
// 它们都应该读同一份记忆、写同一份记忆。所以：
//   · 数据目录固定在**工作区**里，不放在某个会话目录里
//   · 所有写操作走**目录锁**（mkdir 是原子操作），避免两个进程同时改 manifest / ids.txt
//   · 只追加的 JSONL 仍然可以安全并发，锁只是为了让「读-改-写」那几段不打架
//   · 每条记录带 owner（谁写的），这样多 AI 共用一个库也不会失去来源
//
// 为什么不引第三方锁库：本机（以及手机 proot）不能编译原生模块。
// mkdir 锁在所有平台的本地文件系统上都是原子的，够用了。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { assertNotFrozen, frozenNow, isFrozen } from './freeze-guard.mjs';
// 丙方案（2026-11-21）：原文与印象按 scope 分两份文件，路径真源在 src/paths.js。
// 那边只依赖 node:path，不会有环。
import { allEventsDirsOf, impressionsFileForScope, lifeImpressionsFileOf } from './paths.js';

// 代码版本号 —— 让人能一句话判断「这台机器上装的是哪一版」。
//
// 为什么需要它（2026-11-05 晚 的实际问题）：
//   电脑侧当天发了 v5.3 → v5.8 六个包，手机装到哪一版全靠记忆。
//   `package.json` 的 version 一直是 0.4.0（那是数据格式/接口的语义版本，
//   不该跟着每次打包跳），于是「装没装 v5.7」只能靠 grep 某个实现细节来猜
//   （比如 `grep -c injectRole bin/cm-agents.js`）—— 这既不可靠也不该让人去背。
//   → 加一个**只增不改语义**的构建号：每次打包改这一行，然后
//     `cm version` / `cm-watch --help` / `cm-singleton` 抬头都会打出来。
//
// 约定：形如 `YYYY-MM-DD-vN`，日期是打包当天（北京时间）。
// 不参与任何逻辑判断，纯粹是给人看和给脚本核对的。
//
// 2026-11-22 补记：这条「每次打包改这一行」的约定**从 v6.6 到 v6.20 一直没执行** ——
//   `git log -S "CODE_VERSION = '2026" -- src/shared.js` 全历史只有 a04ac2a（v6.6）一笔，
//   于是 v6.21 的机器上 `cm version` 还在打 v6.10，和 CHANGELOG / numbers.json 差十几版。
//   这次补跳到 v6.21，并在 tests/cases/version.mjs 加了「必须与 docs/numbers.json 的 version 一致」
//   一条断言 —— 只改这一行不改那条断言，下次还会悄悄落后。
export const CODE_VERSION = '2026-11-22-v6.21';

export const LOCK_DIRNAME = '.lock';
export const DEFAULT_LOCK_TIMEOUT = 10000;
export const DEFAULT_STALE_LOCK = 30000;

/** 同步睡眠：Node 没有 sleepSync，用 Atomics.wait 在共享内存上等。 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * 找「工作区根目录」。
 *
 * 规则要简单，因为一旦找错，记忆就落到别的目录去了（踩过两次：
 *   ① 用「存在名为 deepseek-harness 的子目录」当标记，结果找到了 C:\Users\su\Documents；
 *   ② 只认 .companion-memory，第一次从子目录跑就建在子目录里。）
 * 所以现在是「先认已有的库，再认 DSH 的默认工作区路径，最后才用 cwd」。
 *   1. CM_WORKSPACE 显式指定
 *   2. 从 cwd 往上找**已经存在**的 .companion-memory —— 沿用上一次的落点
 *   3. 路径里出现 .../deepseek-harness/default-workspace/... 就切在第一段
 *   4. 否则 cwd 本身
 */
export function workspaceRoot(start = process.env.CM_WORKSPACE || process.cwd()) {
  const base = path.resolve(start);
  let dir = base;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.companion-memory'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const parts = base.split(path.sep);
  const i = parts.indexOf('deepseek-harness');
  if (i >= 0 && parts[i + 1] === 'default-workspace') {
    return parts.slice(0, i + 2).join(path.sep) || path.sep;
  }
  return base;
}

/**
 * 记忆库目录。
 *   1. CM_DIR 环境变量（显式指定，最高优先级）
 *   2. 工作区根目录下的 .companion-memory（默认——多会话共享就是靠它）
 *   3. 兜底 ~/.dsh/companion-memory（CM_SCOPE=global）
 */
export function resolveDir({ dir, scope } = {}) {
  if (dir) return path.resolve(dir);
  if (process.env.CM_DIR) return path.resolve(process.env.CM_DIR);
  const s = scope || process.env.CM_SCOPE || 'workspace';
  if (s === 'global') return path.join(os.homedir(), '.dsh', 'companion-memory');
  return path.join(workspaceRoot(), '.companion-memory');
}

/* ------------------------------------------------------------------ *
 * 角色与写权限
 *
 * 用户定的规矩（2026-11-02）：
 *   · 工作 AI（电脑上）可以全部共享**写入**
 *   · 生活 AI **只能读**
 *   · 生活 AI 多在手机上，但手机上有时也做工作
 *
 * 所以门禁挂在**角色**上，不挂在设备上：
 *   同一个库、同一个进程，换个会话换个角色，权限就跟着换。
 * 手机是远程连这台电脑的 DSH（relay），文件系统是同一份，
 * 因此「手机读不到电脑写的」这个问题不存在——除非角色设错。
 * ------------------------------------------------------------------ */

export const ROLE_WORK = 'work';
export const ROLE_LIFE = 'life';
/**
 * 灌库进程的角色：能写全部三层。
 * 为什么需要它：cm-watch / cm-sync 在一个进程里同时搬「工作会话」和「陪伴会话」，
 * 如果按进程角色一刀切，陪伴会话的私密内容就只能落 shared（单向门当场破掉），
 * 或者工作会话被拒写。灌库进程按**会话来源**决定每条落哪层，所以它本身要能写全部。
 * 这不是提权：它只写「会话里本来就有的原文」，不做判断、不改内容。
 */
export const ROLE_SYNC = 'sync';

/**
 * 这个工作区的默认角色（写在 .companion-memory/role 里，一个文件一个词）。
 *
 * 为什么需要它：手机和电脑是两个工作区、两份 AGENTS.md，但跑的是同一套代码。
 * 手机是他的私人设备，默认该是「生活侧」；电脑是干活的地方，默认「工作侧」。
 * 靠 export CM_ROLE 也能做，但那是每个会话都要记得敲的事，忘一次就写错一层。
 * 放在工作区里，一次写定，之后所有进程都按它来 —— 包括灌库、检索、开机自动跑的那些。
 *
 * 合法值：work / life / sync。文件不存在或不认识 → 返回 null，交给后面的兜底。
 */
export function workspaceRole() {
  for (const dir of [workspaceRoot()]) {
    const f = path.join(dir, '.companion-memory', 'role');
    try {
      if (!fs.existsSync(f)) continue;
      const v = fs.readFileSync(f, 'utf8').trim().toLowerCase();
      if (v === ROLE_WORK || v === ROLE_LIFE || v === ROLE_SYNC) return v;
    } catch { /* 读不到就当没设 */ }
  }
  return null;
}

/**
 * 当前角色。
 *   1. CM_ROLE 显式指定（最高优先级：临时切换、单条命令试算）
 *   2. DSH_ROLE 会话级角色（由会话选中的模式注入，见 dsh-cm-role 插件）
 *   3. owner 带前缀时按前缀推断（life:xxx / 生活xxx）
 *   4. 工作区里 .companion-memory/role 写死的默认值
 *   5. 兜底：工作区库默认 work（可写）；全局库默认 life（只读）
 *
 * 为什么 DSH_ROLE 必须排在 role 文件（workspaceRole）之前：
 * role 文件是**设备级**的，一台设备只能整体算一个角色。手机上「工作会话 + 生活会话
 * 并存」就必须让会话级的事实盖过设备级的默认值，否则同一个工作区里开的两个会话
 * 会读成同一个角色，必然一边读错、写错层（红线：工作侧不能看见 life 层）。
 * 排在 CM_ROLE 之后是因为 CM_ROLE 是测试与临时试算的强制口子，不能被环境里的
 * 会话级变量顶掉（tests/run.mjs 顶部钉死 CM_ROLE 做隔离）。
 */
export function resolveRole(explicit) {
  const raw = String(explicit || process.env.CM_ROLE || process.env.DSH_ROLE || '').trim().toLowerCase();
  if (raw === ROLE_WORK || raw === ROLE_LIFE || raw === ROLE_SYNC) return raw;
  let owner = '';
  try { owner = String(resolveOwner()); } catch { owner = ''; }
  if (/^(life|伴|生活)/i.test(owner)) return ROLE_LIFE;
  if (/^(work|工作)/i.test(owner)) return ROLE_WORK;
  const scoped = workspaceRole();
  if (scoped) return scoped;
  const scope = process.env.CM_SCOPE || 'workspace';
  return scope === 'global' ? ROLE_LIFE : ROLE_WORK;
}

/** 只读角色尝试写时抛这个，调用方可以据此给出「这是记录，不是你能改的」。 */
export class ReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyError';
    this.code = 'CM_READ_ONLY';
  }
}

/* ------------------------------------------------------------------ *
 * 可见范围（单向门的实现）
 *
 * 原设计：陪伴侧可看工作痕迹，工作侧永远看不到陪伴侧。
 * 现在要在一个共享库里同时满足两件事：
 *   · 生活 AI（手机）要能读到工作侧记下的东西 —— 否则它一开口就失忆
 *   · 工作 AI 不能看见生活侧的私事 —— 否则单向门就破了
 *
 * 做法：每条记录带 scope，权限按「角色 → 可见范围」算，不按设备算。
 *   shared ：谁记的都能看（用户自己说的话都在这一层）
 *   work   ：工作痕迹。工作侧当然能看，生活侧也能看（单向门允许）
 *   life   ：生活侧自己的记忆。只有生活侧能看能写，工作侧看不见
 * ------------------------------------------------------------------ */

export const SCOPE_SHARED = 'shared';
export const SCOPE_WORK = 'work';
export const SCOPE_LIFE = 'life';

const ALL_SCOPES = [SCOPE_SHARED, SCOPE_WORK, SCOPE_LIFE];

/** 这个角色能看见哪些 scope。 */
export function visibleScopes(role = resolveRole()) {
  if (role === ROLE_LIFE || role === ROLE_SYNC) return ALL_SCOPES.slice(); // 生活侧、灌库进程：全都看得见
  return [SCOPE_SHARED, SCOPE_WORK];                // 工作侧：看不见 life
}

/** 这个角色能写哪些 scope。空数组 = 只读。 */
export function writableScopes(role = resolveRole()) {
  if (role === ROLE_LIFE) return [SCOPE_LIFE]; // 生活侧只写自己的那一层
  if (role === ROLE_SYNC) return ALL_SCOPES.slice(); // 灌库进程按会话来源逐条决定落哪层
  return [SCOPE_SHARED, SCOPE_WORK];           // 工作侧写共享层与工作痕迹层
}

/**
 * 能不能写。
 * 带 scope 时问的是「这一层能不能写」，必须把 scope 真的比对一遍；
 * 早先的版本收了 scope 却只判断「有没有任何可写的地方」，
 * 于是工作侧问 canWrite('life') 也得到 true，而真正落盘时被 assertWritable 拒掉——
 * 会出现「以为记下了，其实没记」的错觉，正是本项目最不想要的那类失败。
 */
export function canWrite(explicit) {
  const allow = writableScopes(resolveRole());
  if (explicit) return allow.includes(explicit);
  return allow.length > 0;
}

/**
 * 写门禁。所有落盘入口都要先过这里。
 * 不静默忽略——静默失败会让陪伴侧以为记下了，其实没记。
 *
 * 两道闸，顺序不能换（N-01 接线 2026-11-19）：
 *   ① 冻结闸：库被 cm freeze on 冻住时，一律拒写（抛 FrozenError，code=CM_FROZEN）。
 *      放在角色闸之前，是因为「全局停了」比「你这一层没权限」更贴近事实，
 *      报错也该先说全局那件事；否则生活会以为是自己身份不对，跑去改 CM_ROLE 却没用。
 *   ② 角色闸：work/life/sync 各自能写哪些 scope。
 * dir 是可选第三参：不传就只做角色闸（老调用方与纯角色用例不受影响）。
 */
export function assertWritable(action = '写入记忆', scope, dir = null) {
  if (dir) assertNotFrozen(dir, action);
  const role = resolveRole();
  const allow = writableScopes(role);
  if (scope ? allow.includes(scope) : allow.length > 0) return true;
  const who = role === ROLE_LIFE ? '生活侧' : '工作侧';
  throw new ReadOnlyError(
    `当前是${who}（角色：${role}），不能${action}${scope ? `（scope=${scope}）` : ''}。\n` +
    `能写的范围是：${allow.length ? allow.join(' / ') : '无'}` +
    (role === ROLE_LIFE ? `\n生活侧只能写 ${SCOPE_LIFE} 那一层；工作侧的记录对它只读。` : '') +
    `\n如果这个会话确实换了角色，设 CM_ROLE=work 或 CM_ROLE=life 再试。`
  );
}

/** 记录该落在哪个 scope：显式指定的优先，否则按角色给默认值。 */
export function scopeFor(explicit) {
  if (explicit) {
    if (!ALL_SCOPES.includes(explicit)) {
      throw new Error(`scope 只能是 ${ALL_SCOPES.join(' / ')}，收到的是 ${explicit}`);
    }
    return explicit;
  }
  const role = resolveRole();
  if (role === ROLE_LIFE) return SCOPE_LIFE;
  // 工作侧默认落 work（2026-11-13 苏尤裁决「落 Work 吧」）。
  //
  // 在此之前这里只有两个出口：life 或 shared，于是辞岸记的每一条印象都进公共层。
  // 公共层有两个后果，一个轻一个重：
  //   · 轻的：工作痕迹与苏尤本人的话混在一起，检索时互相挤占
  //   · 重的：`bin/cm-boot.js:218-221` 里 `if (sc === 'shared') return true;`
  //     → 工作侧的消息被喂进念的情绪状态。设计稿明令禁止「work 驱动 life」，
  //     而它每天都在发生，只是伪装成了 shared。落 work 是修这条红线的直接落点。
  //
  // 为什么不翻 sync：灌库进程逐条按会话来源决定落层（见 scopeForSession），
  // 给它一个整批默认值反而会把判定权抢走。
  if (role === ROLE_WORK) return SCOPE_WORK;
  return SCOPE_SHARED;
}

/** 当前写入者身份。多个 AI 共用一个库时，靠它区分「谁记的」。 */
export function resolveOwner(explicit) {
  const name = explicit || process.env.CM_OWNER || process.env.DSH_AGENT_NAME || process.env.DSH_TEAM_MEMBER || '';
  const clean = String(name).trim().slice(0, 40);
  if (clean) return clean;
  return `pid:${process.pid}@${os.hostname().slice(0, 24)}`;
}

/** 目录锁。拿不到就等，超时报错（不静默丢写）。 */
export function withLock(keyDir, fn, { timeoutMs = DEFAULT_LOCK_TIMEOUT, staleMs = DEFAULT_STALE_LOCK } = {}) {
  const lockPath = path.join(keyDir, LOCK_DIRNAME);
  const start = Date.now();
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁：持锁进程崩了，mkdir 留下的目录会永远在。超时就抢过来。
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* 锁刚被释放，重试 */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`拿不到记忆库写锁（${lockPath}），等了 ${timeoutMs}ms。可能是别的会话正在写。`);
      }
      sleepSync(10 + Math.floor(Math.random() * 30));
    }
  }
  try {
    try {
      fs.writeFileSync(
        path.join(lockPath, 'owner'),
        `${process.pid}\t${os.hostname()}\t${Date.now()}\n`,
        'utf8'
      );
    } catch { /* 只为排障，写不进去不影响正确性 */ }
    return fn();
  } finally {
    if (held) {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* 已被判陈旧清掉 */ }
    }
  }
}

/** 锁现在的状态（诊断用）。 */
export function lockState(dir) {
  const lockPath = path.join(dir, LOCK_DIRNAME);
  try {
    const st = fs.statSync(lockPath);
    let holder = '';
    try { holder = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim(); } catch {}
    return { locked: true, ageMs: Date.now() - st.mtimeMs, holder };
  } catch {
    return { locked: false, ageMs: 0, holder: '' };
  }
}

/** 文件「当前有没有变」的廉价指纹：路径 + 大小 + mtime。 */
export function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${path.basename(file)}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return `${path.basename(file)}:missing`;
  }
}

export function hashOf(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/**
 * 记忆库的「参与方」：从原文与印象里翻出所有出现过的 owner。
 * 用来确认多会话共享真的生效了，而不是自己在自言自语。
 */
export function participants(dir, { max = 20 } = {}) {
  const counts = new Map();
  const bump = (owner) => {
    if (!owner) return;
    counts.set(owner, (counts.get(owner) || 0) + 1);
  };
  // 丙方案（2026-11-21）：life 的原文与印象落在本机专属文件里，
  // 但也得算进「参与方」—— 只数被同步的那一半，会把生活侧的人整个漏掉，
  // 而「参与方」这个统计存在的意义就是确认多会话真的都在写。
  for (const eventsDir of allEventsDirsOf(dir)) {
    try {
      for (const f of fs.readdirSync(eventsDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const raw = fs.readFileSync(path.join(eventsDir, f), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try { bump(JSON.parse(line).meta?.owner); } catch {}
        }
      }
    } catch {}
  }
  for (const impFile of [impressionsFileForScope(dir, 'shared'), lifeImpressionsFileOf(dir)]) {
    try {
      for (const line of fs.readFileSync(impFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { bump(JSON.parse(line).owner); } catch {}
      }
    } catch {}
  }
  return [...counts.entries()]
    .map(([owner, n]) => ({ owner, n }))
    .sort((a, b) => b.n - a.n || a.owner.localeCompare(b.owner))
    .slice(0, max);
}

/* ------------------------------------------------------------------ *
 * AGENTS.md 注入快照的唯一判据
 *
 * 为什么要有这个函数（2026-11-05 的真实事故）：
 *   同一个判据原本被抄成了两份 —— 一份在 src/ingest.js 的守卫里（拦新灌进来的），
 *   一份在 bin/cm-decontaminate.js 的规则 E 里（清已经在库里的）。
 *   两份一旦不同步，就会出现「守卫拦得住、体检看不见」这种自相矛盾：
 *   手机端用守卫判据扫出库里躺着 30 条旧快照，而 cm-decontaminate 按自己的
 *   规则 A/B 报 0 条 —— 因为 A/B 看的是「命中几条 10 字 life 特征」，
 *   这 30 条只到「12 字连续片段」级别命中，够不上。于是它们躺了半个月没人清。
 *
 *   所以现在只有这一份实现，两边都 import 它。要改判据就改这里，改一次两边都变。
 *
 * 判据（三条同时满足才算）：
 *   1. 以 <system-reminder 开头   —— 硬前提：DSH 注入的形态
 *   2. 提到 AGENTS.md             —— 硬前提
 *   3. CM:BEGIN 或文件头生成标记  —— 命中其一即可（A 或 B）
 *
 * 为什么第 3 条要 A 或 B 两个：
 *   原文层对单条 text 有 DEFAULT_MAX_TEXT=4000 的截断（src/store.js）。
 *   生活侧 AGENTS.md 带整段 life 印象时更长，被截掉的正是尾部 CM:BEGIN，
 *   而文件头那句「记忆库段落由 `node bin/cm-agents.js` 生成」反而活下来。
 *   只认 CM:BEGIN 就会把这种快照漏进 shared 层（实测漏了 3 条）。
 *
 * 为什么前两条硬前提不能松：
 *   只认 CM:BEGIN 会把「讨论 AGENTS.md 的正常原话」一起吞掉 ——
 *   而「记录要完全保留，甚至我们说的每一句话」是硬要求。
 * ------------------------------------------------------------------ */

/** cm-agents 写死在 AGENTS.md 文件头的固定标记（不是 CM:BEGIN 那种段标记）。 */
export const AGENTS_GENERATED_MARK = '记忆库段落由 `node bin/cm-agents.js` 生成';

/** 这条文本是不是 AGENTS.md 注入快照（守卫与去污染工具共用的唯一判据）。 */
export function isAgentsSnapshot(text) {
  const t = String(text || '');
  if (!/^\s*<system-reminder/i.test(t)) return false;   // 硬前提 1
  // 硬前提 2：注入的是「哪一份指令文件」。路线B（2026-11-13）之后有三个文件名，
  // 宿主会把路径原样写进 `Updated instructions from: <basename>`：
  //   AGENTS.md（底座）/ AGENTS.work.md / AGENTS.life.md
  // 旧预览名 AGENTS.md.work、AGENTS.md.life 也一并认（历史会话里还留着）。
  // 以前这里只写 /AGENTS\.md/ —— 换成 AGENTS.work.md 之后**一条都匹配不到**，
  // 注入快照会整段漏进库，等于把 auto-injection 灌成原话（正是 11/4 事故的形态）。
  if (!/AGENTS(?:\.(?:work|life))?\.md/.test(t)) return false;
  return t.includes('<!-- CM:BEGIN') || t.includes(AGENTS_GENERATED_MARK);
}

/* ------------------------------------------------------------------ *
 * 单实例租约（长驻进程用）
 *
 * withLock 是「短临界区」锁：进函数 mkdir、出函数 rm，毫秒级。
 * 长驻进程要的是另一件事：进程活着期间一直持有，死了自动可被接管。
 *
 * 为什么必须单独做（2026-11-05 事故）：
 *   手机上有三条路径都能拉起 cm-watch ——
 *     · deploy/cm-watch-start.sh（手动/trigger-entry 调）
 *     · deploy/dsha-mem-keepalive/loop.sh（定时 chroot 进来调 trigger-entry）
 *     · deploy/dsha-mem-keepalive/loop.sh（同上，另一套模块）
 *   每套都会起一个 guard，每个 guard 起一个 cm-watch。实测同一会话的记录被
 *   10 个不同 PID 在 5 分钟窗口内交替写入，一半 life 一半 shared ——
 *   因为各进程的 CM_LIFE_WORKSPACES 环境不一样，同一个会话被判到不同层。
 *   `pgrep -f cm-watch.js` 在 proot/容器内外是**互相看不见**的，所以
 *   「pgrep 数出来 1 个」和「10 个 PID 在写盘」可以同时成立。
 *
 * 所以判据不能是进程列表，必须是**库里的租约**：谁拿着租约谁才有权灌库。
 * 后来者拿不到就退出（exit 3），守护脚本看到 3 就不再重启 —— 天然收敛。
 * ------------------------------------------------------------------ */

export const SINGLETON_EXIT_CODE = 3;
const SINGLETON_DIRNAME = '.singleton';

/**
 * 抢一个长驻租约。拿到返回 {ok:true, release}；拿不到返回 {ok:false, holder}。
 *
 * @param {string} dir      记忆库根目录（租约放 <dir>/.singleton/<name>/）
 * @param {string} name     租约名，比如 'cm-watch'
 * @param {object} opts     { staleMs } 超过这么久没心跳就认为持有者已死
 */
export function acquireSingleton(dir, name, { staleMs = DEFAULT_STALE_LOCK } = {}) {
  const base = path.join(dir, SINGLETON_DIRNAME);
  const lockPath = path.join(base, name);
  const ownerPath = path.join(lockPath, 'owner');
  // 心跳文件：内容 `pid\t毫秒时间戳`，由持有者自己写。见下面 beatAgeMs 的事故注释。
  const beatPath = path.join(lockPath, 'beat');

  /** 写心跳文件。持有者每轮调一次，判活靠它的 pid + 时间戳。 */
  const writeBeat = () => {
    try {
      fs.mkdirSync(lockPath, { recursive: true });
      const ts = Date.now();
      fs.writeFileSync(beatPath, `${process.pid}\t${ts}\n`, 'utf8');
      // 目录 mtime 同时刷新，兼容只看 mtime 的老逻辑（升级灰度期间两边都新鲜）。
      try { fs.utimesSync(lockPath, new Date(ts), new Date(ts)); } catch {}
    } catch { /* 心跳写不进不该影响租约本身（目录存在就是持有） */ }
  };

  const writeOwner = () => {
    try {
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(ownerPath, `${process.pid}\t${os.hostname()}\t${Date.now()}\n`, 'utf8');
    } catch { /* 排障信息，写不进不影响租约本身（目录存在就是持有） */ }
    writeBeat();
  };

  const readOwner = () => {
    try {
      const [pid, host, since] = fs.readFileSync(ownerPath, 'utf8').trim().split('\t');
      return { pid: Number(pid), host, since: Number(since) };
    } catch { return null; }
  };

  /**
   * 心跳有多久没动（毫秒）。读不到算无穷大。
   *
   * 2026-11-13 事故（P0 静默停摆）：心跳原来只看目录 mtime，而**任何**有写权限的
   * 进程都能 utimes 刷新它 —— 于是「持有者 pid 早就不干活了」和「心跳 5 秒前」可以
   * 同时成立，后来者永远抢不到租约，旧进程继续空转。
   * 真凶：proot 不建 PID 命名空间，容器内 process.kill(旧的 uid0 pid, 0) 抛 EPERM，
   * 被 holderAlive 当成「还活着」；加上目录 mtime 一直被刷新 → 判活恒真。
   *
   * 修法：心跳落成**文件**，由持有者写入自己的 pid + 时间戳；判活要求文件里的 pid
   * 与 owner.pid 一致，不一致直接判死。老代码不写这个文件 → 老持有者无法再伪装新鲜。
   * 文件不存在时回退旧的目录 mtime 逻辑（向后兼容：升级瞬间不会把正常持有者判死）。
   */
  const beatAgeMs = () => {
    try {
      const [bpid, bts] = fs.readFileSync(beatPath, 'utf8').trim().split('\t');
      const o = readOwner();
      const pid = Number(bpid);
      const ts = Number(bts);
      if (o && Number.isFinite(o.pid) && pid !== o.pid) return Infinity;
      if (!Number.isFinite(ts)) return Infinity;
      return Date.now() - ts;
    } catch { /* 没有 beat 文件 → 老持有者，退回目录 mtime */ }
    try { return Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return Infinity; }
  };

  /** 持有者是否还活着。**pid 活着不等于持有者活着**，见下面的坑。 */
  const holderAlive = () => {
    const o = readOwner();
    if (o && o.host === os.hostname() && Number.isFinite(o.pid) && o.pid > 0) {
      let pidAlive = false;
      try { process.kill(o.pid, 0); pidAlive = true; } catch (e) { pidAlive = e.code === 'EPERM'; }
      if (!pidAlive) return false;
      // ⚠️ 2026-11-06 的坑：pid 活着**不能**当作持有者活着。
      //   1. Windows 上 EPERM 不等于「是我们的进程」——只要那个 pid 被任何
      //      进程占着就会抛 EPERM。实测 pid 19540 早已是 GBT_DL_LIB.exe，
      //      但 cm-reflect 的租约因此被判成「还活着」，guard 每 10 秒拉起
      //      一个新进程、每个都打「已有 cm-reflect 在跑」并以退出码 3 退出，
      //      日志刷了 4 万字节而**一轮反思都没跑**（https://… 见 CHANGELOG v6.2）。
      //   2. pid 会被复用：持有者真的死了，系统把同一个号发给别人，
      //      kill 0 依然成功。
      // 所以判活 = 「pid 在」**且**「心跳够新」。心跳由持有者每轮 beat()。
      // 代价：持有者必须在 staleMs 内至少 beat 一次（cm-watch 每轮 beat，
      // cm-reflect 每轮起止各 beat 一次）。这个代价是我们愿意付的——
      // 误判「还活着」会让功能永久瘫痪，误判「死了」只会多重启一次。
      return beatAgeMs() < staleMs;
    }
    // 跨机（或 owner 文件损坏）：只能看心跳。
    return beatAgeMs() < staleMs;
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.mkdirSync(lockPath, { recursive: false });   // 原子：成功即独占
      writeOwner();
      let released = false;
      return {
        ok: true,
        holder: null,
        path: lockPath,
        /** 心跳：长驻进程每轮调一次，跨机判断存活靠它。 */
        beat: () => writeBeat(),
        release: () => {
          if (released) return;
          released = true;
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (holderAlive()) return { ok: false, holder: readOwner() };
      // 持有者已死（或跨机且心跳过期）：清掉重抢。
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    }
  }
  return { ok: false, holder: readOwner() };
}

/** 看一眼租约现在被谁持有（诊断用，不抢）。 */
export function singletonState(dir, name) {
  const lockPath = path.join(dir, SINGLETON_DIRNAME, name);
  try {
    const st = fs.statSync(lockPath);
    let holder = null;
    try {
      const [pid, host, since] = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim().split('\t');
      holder = { pid: Number(pid), host, since: Number(since) };
    } catch {}
    // 心跳优先读 beat 文件（要与 owner.pid 对上），读不到才退回目录 mtime。
    // 与 acquireSingleton 里的 beatAgeMs 保持同一口径，否则诊断结果会骗人。
    let beatAgeMs = Date.now() - st.mtimeMs;
    try {
      const [bpid, bts] = fs.readFileSync(path.join(lockPath, 'beat'), 'utf8').trim().split('\t');
      const pid = Number(bpid);
      const ts = Number(bts);
      if (holder && Number.isFinite(holder.pid) && pid !== holder.pid) beatAgeMs = Infinity;
      else if (Number.isFinite(ts)) beatAgeMs = Date.now() - ts;
    } catch { /* 老持有者没有 beat 文件，用目录 mtime */ }
    return { held: true, ageMs: Date.now() - st.mtimeMs, beatAgeMs, holder };
  } catch {
    return { held: false, ageMs: 0, beatAgeMs: 0, holder: null };
  }
}
