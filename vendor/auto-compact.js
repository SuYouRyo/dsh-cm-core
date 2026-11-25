// 自动压缩上下文 —— 2026-11-11 加回（苏尤令：「轮数达到 60 或上下文达到 70% 自动压缩，
// 不动现有的」）。
//
// 历史：审计文档 §6.1 第 1 条、docs/设计稿-cm-reflect.md §10.3 原本写「会话窗口用量
// ≥60% 或轮次 ≥80 时自动生成续接包」，被标「本期不做」，理由是「cm-reflect 拿不到
// 主对话 token 用量、跨进程契约没定」。苏尤现在把阈值定为「轮数 60 / 上下文 70%」，
// 并明确「不动现有的」。
//
// 本模块的设计边界（守「不动现有的」）：
//   ① **只做判定 + 编排**：阈值判定是纯函数；真要压时复用现有
//      buildArchive / compressArchive / writePendingPointer 三个已标定实现，
//      一行都不改它们、不改 cm archive --compress、不改 cm-agents 一次性指针链路。
//   ② **跨进程契约由调用方上报**：记忆库进程拿不到宿主 token 用量，所以不猜、不扫盘
//      估上下文；由调用方显式给 turns / ratio（CLI --turns / --ratio，或将来宿主钩子）。
//      这正是当年「本期不做」卡住的那一步，现在用「显式上报」补上，不偷偷依赖宿主。
//   ③ **默认关**：CM_AUTO_COMPACT=1 才生效；CM_NO_AUTO_COMPACT=1 一键关且优先级最高。
//      不开时本模块对现网零影响（不写盘、不联网、不调模型）。
//   ④ **每会话一次**：同会话已压过就不再压（状态落本地 state 文件，幂等、可查）。
//
// 触发后的动作 = 现有 K6「存档 + 压缩 + 写一次性指针」链路，即：下一个新会话开场
// cm-agents 会把「存档在哪」注入一次（读后即作废）。这不是「每轮注入存档内容」。

import fs from 'node:fs';
import path from 'node:path';

/** 默认阈值（苏尤 2026-11-11 定）。 */
export const AUTO_COMPACT_DEFAULTS = {
  turnThreshold: 60,        // 轮数达到 60
  contextRatioThreshold: 0.70 // 上下文用量达到 70%
};

export const STATE_FILENAME = 'auto-compact-state.json';

/** 环境变量开关：默认关；一键关优先于显式开。 */
export function autoCompactEnabled(env = process.env) {
  if (env.CM_NO_AUTO_COMPACT === '1') return false;
  return env.CM_AUTO_COMPACT === '1';
}

/**
 * 纯判定：该不该触发自动压缩。
 *
 * @param {object}  input
 * @param {number}  [input.turns]        当前会话轮数
 * @param {number}  [input.contextRatio] 上下文用量，0~1（>1 视作百分比误传，归一到 /100）
 * @param {boolean} [input.enabled]      开关；不传则读环境变量
 * @param {object}  [input.thresholds]   覆盖阈值（测试/调参用）
 * @param {boolean} [input.alreadyDone]  本会话已压过（由 state 给出）
 * @returns {{ trigger:boolean, reason:string, by:string|null, turns:number|null, ratio:number|null }}
 */
export function shouldAutoCompact({
  turns = null, contextRatio = null, enabled = null, thresholds = null, alreadyDone = false
} = {}) {
  const on = enabled == null ? autoCompactEnabled() : !!enabled;
  if (!on) return { trigger: false, reason: '未启用（CM_AUTO_COMPACT=1 才开）', by: null, turns: null, ratio: null };
  if (alreadyDone) return { trigger: false, reason: '本会话已压缩过（每会话一次）', by: null, turns: null, ratio: null };

  const th = { ...AUTO_COMPACT_DEFAULTS, ...(thresholds || {}) };
  const t = Number.isFinite(Number(turns)) ? Number(turns) : null;
  let r = Number.isFinite(Number(contextRatio)) ? Number(contextRatio) : null;
  if (r != null && r > 1) r = r / 100;   // 有人传 70 而不是 0.70

  // 两个条件任一满足即触发；turns 优先说清是「轮数」触发，便于日志。
  if (t != null && t >= th.turnThreshold) {
    return { trigger: true, reason: `轮数 ${t} ≥ ${th.turnThreshold}`, by: 'turns', turns: t, ratio: r };
  }
  if (r != null && r >= th.contextRatioThreshold) {
    return { trigger: true, reason: `上下文 ${(r * 100).toFixed(0)}% ≥ ${(th.contextRatioThreshold * 100).toFixed(0)}%`, by: 'ratio', turns: t, ratio: r };
  }
  return {
    trigger: false,
    reason: `未达阈值（轮数 ${t ?? '?'} < ${th.turnThreshold}，上下文 ${r == null ? '?' : (r * 100).toFixed(0) + '%'} < ${(th.contextRatioThreshold * 100).toFixed(0)}%）`,
    by: null, turns: t, ratio: r
  };
}

/** 状态文件路径（本地专属，不进同步、不进 git —— 与 reflect-state 同纪律）。 */
export function autoCompactStateFile(memDir) {
  return path.join(memDir, STATE_FILENAME);
}

/** 读状态（坏文件/缺文件一律当「没压过」，fail-open 不炸开场）。 */
export function readAutoCompactState(memDir) {
  try {
    const j = JSON.parse(fs.readFileSync(autoCompactStateFile(memDir), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

/** 本会话是否已压过。 */
export function alreadyCompacted(memDir, sessionId) {
  if (!sessionId) return false;
  const st = readAutoCompactState(memDir);
  return String(st.session || '') === String(sessionId) && st.done === true;
}

/** 记一次「本会话已压」（append 式留痕，不静默覆盖历史）。 */
export function markCompacted(memDir, { session, at = Date.now(), file, count, by } = {}) {
  try {
    const p = autoCompactStateFile(memDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });   // newDir() 只给路径不建目录，与 compressArchive 同纪律
    const prev = readAutoCompactState(memDir);
    const next = { ...prev, session: session || null, done: true, lastAt: at, lastFile: file || null, lastCount: count ?? null, lastBy: by || null };
    fs.writeFileSync(p, JSON.stringify(next) + '\n', 'utf8');
    return { ok: true, state: next };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 编排：判定通过后，**复用现有**三个 API 完成压缩，再记状态。
 * 这一步才写盘；纯判定 shouldAutoCompact 不写任何东西。
 *
 * @param {object} mem       open() 返回
 * @param {object} deps      依赖注入（默认 import 现有模块，测试可传桩）
 * @returns {Promise<object>} 统一返回 {trigger, reason, applied, file?, pointer?, note?}
 */
export async function runAutoCompact(mem, {
  turns = null, contextRatio = null, session = null, enabled = null, thresholds = null,
  dir = null, name = null,
  buildArchive = null, compressArchive = null, writePendingPointer = null
} = {}) {
  const done = alreadyCompacted(mem.dir, session);
  const d = shouldAutoCompact({ turns, contextRatio, enabled, thresholds, alreadyDone: done });
  if (!d.trigger) return { trigger: false, reason: d.reason, applied: false };

  const B = buildArchive || (await import('./archive.js')).buildArchive;
  const C = compressArchive || (await import('./archive-compress.js')).compressArchive;
  const W = writePendingPointer || (await import('./archive-compress.js')).writePendingPointer;

  const a = B(mem, {});
  if (!a.ok) return { trigger: true, reason: d.reason, applied: false, note: `存档生成失败：${a.reason}` };
  const c = C(mem.dir, a, { dir, name });
  if (!c.ok) return { trigger: true, reason: d.reason, applied: false, note: `压缩失败：${c.reason}` };
  const p = W(mem.dir, c, { dir });
  if (!p.ok) return { trigger: true, reason: d.reason, applied: false, note: `指针写入失败：${p.reason}` };

  const marked = markCompacted(mem.dir, { session, file: c.file, count: c.count, by: d.by });
  return {
    trigger: true, reason: d.reason, applied: true,
    file: c.file, count: c.count, sha256: c.sha256, pointer: p.pointer,
    note: marked.ok ? '已压缩并写一次性指针；本会话不再重复' : `压缩成功但状态记账失败：${marked.reason}`
  };
}
