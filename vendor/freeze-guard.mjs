// N-01「终止指令」A 层核心 · 冻结状态**只读**入口 + 拒写判定（2026-11-19）
//
// 设计依据：设计稿-终止指令让一切可控-20261111.md 的 B 方案 ——
//   cm freeze on|off|status，状态落 .companion-memory/freeze.json（本地专属、不进 git、不进同步）。
//
// 本轮口径（WO-007，只做 A 层，缩小范围）：
//   · 只做「状态落盘（在 bin/cm.js）+ 读入口（本模块）+ 拒写判定（本模块）」三件核心事；
//   · 不做 B/C 层：不接微信端触发、不做云端下发；
//   · **不侵入** remember / appendRaw / saveState 等所有写路径 —— 侵入式接线留后续工单，
//     本模块只提供判定函数，由调用方自愿在写入口调用（本轮除 freeze 命令自身外无人调用）。
//
// 红线：
//   · 本模块**绝不写文件**，只读 freeze.json；
//   · 冻结是「不写」，不是「抹掉」：不删原文、不 kill 进程；
//   · 坏文件 / 读不到 → 一律 **fail-open**（视为未冻结）。理由：一个坏 JSON 不该把
//     整个库锁死，下次会话谁都解不开（设计稿 §四「不做自动解冻」的反面风险）；
//   · 拒绝写入时必须给出明确中文原因，不许静默吞掉（守「不许静默失败」硬纪律）。

import fs from 'node:fs';
import path from 'node:path';

/** freeze.json 在记忆库数据目录下的固定文件名。 */
export const FREEZE_FILENAME = 'freeze.json';

/**
 * 算出 freeze.json 的绝对路径。
 * @param {string} rootDir 记忆库数据目录（即 mem.dir / <工作区>/.companion-memory）。
 * @returns {string}
 */
export function freezeFilePath(rootDir) {
  return path.join(rootDir, FREEZE_FILENAME);
}

/**
 * 读冻结状态原始对象。文件不存在 / 读失败 / JSON 坏掉 / 形状不对 → 返回 null（fail-open）。
 * @param {string} rootDir 记忆库数据目录（mem.dir）。
 * @returns {{frozen: boolean, at?: number, reason?: string} | null}
 */
export function readFreezeState(rootDir) {
  if (!rootDir) return null;
  try {
    const p = freezeFilePath(rootDir);
    if (!fs.existsSync(p)) return null;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (typeof obj.frozen !== 'boolean') return null;
    return obj;
  } catch {
    // 读不动 / 解析不了 = 没有可用的冻结状态，Fail-open 不把库锁死。
    return null;
  }
}

/**
 * 读入口：当前是否处于冻结态。
 * @param {string} rootDir 记忆库数据目录（mem.dir）。
 * @returns {boolean} 仅当 freeze.json 存在且 frozen === true 时返回 true；其余一律 false。
 */
export function isFrozen(rootDir) {
  const st = readFreezeState(rootDir);
  return !!(st && st.frozen === true);
}

/**
 * 拒写判定（guard）：调用方在写入口处问一句「现在能不能写」。
 * 返回 null = 允许写；返回中文字符串 = 拒绝原因，调用方据此明确回报并停止写入。
 * 这样设计是为了守「不许静默失败」——拒绝时说清是谁在何时因何冻的。
 *
 * ⚠️ 本轮 A 层核心**没有**把它接进各写路径；等后续工单显式接线。
 * cm freeze on/off 是控制通道，刻意不调用本函数，否则会把解冻命令自己也锁住。
 *
 * @param {string} rootDir 记忆库数据目录（mem.dir）。
 * @returns {string | null}
 */
export function freezeGuard(rootDir) {
  if (!isFrozen(rootDir)) return null;
  const st = readFreezeState(rootDir);
  let when = '未知时间';
  if (st && st.at && Number.isFinite(Number(st.at))) {
    try { when = new Date(Number(st.at)).toISOString(); } catch { /* 保留「未知时间」 */ }
  }
  const why = st && st.reason ? String(st.reason) : '未注明原因';
  return `已冻结（${when}，原因：${why}）—— 本次写入被拒；执行 cm freeze off 解冻后再写`;
}

/* ------------------------------------------------------------------ *
 * 侵入式接线（N-01 B 层，2026-11-19）
 *
 * A 层只提供「读状态 + 给拒绝理由」；B 层把它接进各写入口，并补两件缺不了的东西：
 *   ① 一个带 code 的异常，让调用方（CLI / cm-watch / 反思循环）能分辨
 *      「因为冻结被拒」和「因为角色只读被拒」——两者都叫「写不进去」但处置完全不同；
 *   ② 被挡下的写入计数落在本地 freeze-audit.jsonl（设计稿「不作静默丢弃」：
 *      status 要能报出「冻结期间被挡下的写入次数」，计数只落本地、不入库、不进同步）。
 *
 * 边界（与 A 层同一套，不改）：
 *   · 冻结是「不写」，不是「抹掉」：不删原文、不 kill 进程、不改设备侧；
 *   · 坏文件 / 读不到 → 仍然 fail-open，一个坏 JSON 不该把整个库锁死；
 *   · 计数写不进去也绝不抛（记账失败不能反过来把主流程打死）。
 * ------------------------------------------------------------------ */

/** 冻结期写入被拒时抛这个，调用方可据 code === 'CM_FROZEN' 分流处置。 */
export class FrozenError extends Error {
  constructor(message, { at = null, reason = '' } = {}) {
    super(message);
    this.name = 'FrozenError';
    this.code = 'CM_FROZEN';
    this.frozenAt = at;
    this.freezeReason = reason;
  }
}

/** 被挡下的写入计数文件名（本地专属：进 cm-remote 的 LOCAL_ONLY 与 .gitignore）。 */
export const FREEZE_AUDIT_FILENAME = 'freeze-audit.jsonl';

export function freezeAuditPath(rootDir) {
  return path.join(rootDir, FREEZE_AUDIT_FILENAME);
}

/**
 * 记一条「这次写入被冻住了」。只落本地，绝不抛。
 * @returns {boolean} 是否真的写进去（失败返回 false，不影响调用方继续拒绝写入）
 */
export function recordBlockedWrite(rootDir, action = '写入记忆') {
  if (!rootDir) return false;
  try {
    const st = readFreezeState(rootDir);
    const row = {
      t: Date.now(),
      action: String(action || '写入记忆'),
      frozenAt: st && Number.isFinite(Number(st.at)) ? Number(st.at) : null,
      reason: st && st.reason ? String(st.reason) : null
    };
    fs.appendFileSync(freezeAuditPath(rootDir), JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 冻结期间被挡下的写入次数（cm freeze status 要报这个数）。
 * 文件不存在 / 读不动 → 0。
 */
export function countBlockedWrites(rootDir) {
  if (!rootDir) return 0;
  try {
    const txt = fs.readFileSync(freezeAuditPath(rootDir), 'utf8');
    return txt.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * 写入口的硬门禁：冻结时先记一笔计数，再抛 FrozenError（不静默、不降级）。
 * 未冻结时返回 true，调用方接着做角色门禁。
 */
export function assertNotFrozen(rootDir, action = '写入记忆') {
  const msg = freezeGuard(rootDir);
  if (!msg) return true;
  recordBlockedWrite(rootDir, action);
  const st = readFreezeState(rootDir) || {};
  throw new FrozenError('不能' + action + '：' + msg, {
    at: Number.isFinite(Number(st.at)) ? Number(st.at) : null,
    reason: st.reason ? String(st.reason) : ''
  });
}

/**
 * 给「不抛、只返回失败」的写入口用：冻结了就记一笔并返回 true，调用方据此跳过写。
 * 这类入口（向量、账本、情绪层、会话落定表）的契约本来就是「失败不抛」，
 * 硬塞异常会把开场/灌库流程一起带崩 —— 那是另一种「静默事故」。
 */
export function frozenNow(rootDir, action = '写入记忆') {
  if (!isFrozen(rootDir)) return false;
  recordBlockedWrite(rootDir, action);
  return true;
}
