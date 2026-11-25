// reinject：上下文压缩之后的「强制重注入」判定（工单 T-20261115-019）。
//
// 背景（为什么需要这个文件）：
//   selfNote（旧我画像）与 handoff（当前状态）的注入是「每会话一次」，判定在
//   handoff.js 的 oncePerSession：`lastSessionId` 相同就跳过。这是刻意的——
//   每轮灌一遍等于别人每隔十秒告诉你你是谁。
//
//   但宿主做 Context Compaction 时，**注入进去的那一份会被折叠进摘要**。
//   会话身份（session id）没变，于是下一轮判定仍然认为「本会话已经注入过」，
//   不再注入；而带原文的那份已经被压掉了 —— 表现就是「瞬间失忆」。
//
//   所以需要第三个信号：**压缩代次**（compaction epoch）。它变了 = 注入过的东西
//   可能已经被折叠掉了 = 下一轮无条件放行一次。
//
// 压缩代次的来源（已在宿主代码里确证，不是猜的）：
//   @deepseek-ai/dsh-session 的 SurfaceManager 每执行一次 surface replace
//   （压缩提交时就是 replace）就把 `replaceGeneration` 加一，单调不减。
//   插件在 pre-step / systemPrompt 装配时手里有 `context.agent.session`，
//   直接读 `session.surface.replaceGeneration` 即可，全程只读，不改宿主。
//
// 纪律：
//   · 拿不到代次（没有 session、字段不是非负整数）就**明说拿不到**，退回落差判定，
//     绝不编一个假信号。
//   · 强制只放行一次：消费掉这个代次之后，下一轮自动回落到阈值判定（防刷屏）。
//   · 判定与记账分离：reinjectDecide 只读，reinjectCommit 才写。
//   · 记账按 key 分开（selfNote / handoff 各一份账），互不抢占。

import fs from 'node:fs';
import path from 'node:path';
import { handoffReadState, handoffUpdateState } from './handoff.js';

/** reflect-state.json 里本模块独占的键。 */
export const REINJECT_KEY = 'reinject';
export const REINJECT_LOG_DIRNAME = 'logs';
export const REINJECT_LOG_FILENAME = 'reinject.log';

/** 日志开关：默认关（不加噪音），要追问题时 CM_REINJECT_LOG=1。 */
export function reinjectLogEnabled(env = process.env) {
  return env.CM_REINJECT_LOG === '1';
}

export function reinjectLogPathOf(memDir) {
  return path.join(memDir, REINJECT_LOG_DIRNAME, REINJECT_LOG_FILENAME);
}

/**
 * 写一行注入日志。失败不抛：日志坏掉不该影响注入本身。
 * 格式照 emotion-inject.log：一行一条，key=value 平铺，便于 grep。
 */
export function writeReinjectLog(memDir, fields, { enabled = reinjectLogEnabled() } = {}) {
  if (!enabled) return false;
  try {
    const p = reinjectLogPathOf(memDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const body = Object.entries(fields || {})
      .map(([k, v]) => `${k}=${v === null || v === undefined ? '-' : v}`)
      .join(' ');
    fs.appendFileSync(p, `[reinject] t=${new Date().toISOString()} ${body}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从会话对象读「压缩代次」。
 *
 * 读不到返回 null —— 调用方据此退回落差判定，并在日志里记 no-epoch。
 * 绝不返回 0 冒充「没压缩过」：0 与 null 是两件事。
 */
export function compactionEpochOf(session) {
  try {
    const n = session?.surface?.replaceGeneration;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** 把 env / 命令行里的一串数字解析成代次；不是非负整数就返回 null。 */
export function parseEpoch(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function slotOf(state, key) {
  const root = state && typeof state === 'object' ? state[REINJECT_KEY] : null;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  const s = root[key];
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/**
 * 只读：某个 key 的记账现状。
 * @returns {{lastEpoch: number|null, lastSessionId: string|null, lastInjectedAt: number, forcedAt: number, forcedCount: number}}
 */
export function reinjectState(dir, key = 'selfNote') {
  const slot = slotOf(handoffReadState(dir), key);
  return {
    lastEpoch: Number.isInteger(slot.lastEpoch) ? slot.lastEpoch : null,
    lastSessionId: slot.lastSessionId ? String(slot.lastSessionId) : null,
    lastInjectedAt: Number(slot.lastInjectedAt) || 0,
    forcedAt: Number(slot.forcedAt) || 0,
    forcedCount: Number(slot.forcedCount) || 0
  };
}

/**
 * 判定：这一轮该不该注入，以及为什么。
 *
 * **只读，不写任何状态。** 记账归 reinjectCommit。
 *
 * action 取值：
 *   'force'     —— 检测到压缩（代次前进），无条件放行一次；
 *   'threshold' —— 没有压缩可用信号，或这一代次已经处理过，回落到阈值判定；
 *   'adopt'     —— 第一次见到这个会话 / 换会话 / 代次回退：只登记基线，不强制；
 *   'skip'      —— 上层已经判死（CM_NO_SELFNOTE=1、库里没有条目）：连基线都不记。
 *
 * @param {string} dir 库目录
 * @param {object} opts
 * @param {string|null} [opts.sessionId]
 * @param {number|null} [opts.epoch] 压缩代次；null = 拿不到信号
 * @param {string} [opts.key] 记账槽位（'selfNote' / 'handoff'）
 * @param {{inject: boolean, reason?: string}} [opts.base] 阈值判定的结论
 * @param {number} [opts.now]
 */
export function reinjectDecide(dir, { sessionId = null, epoch = null, key = 'selfNote', base = { inject: false }, now = Date.now() } = {}) {
  const st = reinjectState(dir, key);
  const cur = Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
  const sid = sessionId ? String(sessionId) : null;
  const common = { key, base, epoch: cur, lastEpoch: st.lastEpoch, sessionId: sid, now };

  // 上层判死（开关关掉 / 库里没条目）：连代次基线都不记，免得把压缩事件吞掉。
  if (base && base.reason === 'disabled') return { ...common, action: 'skip', reason: 'disabled' };
  if (base && base.reason === 'empty') return { ...common, action: 'skip', reason: 'empty' };

  if (cur === null) return { ...common, action: 'threshold', reason: 'no-epoch' };

  const sameSession = Boolean(sid && st.lastSessionId && st.lastSessionId === sid);
  if (st.lastEpoch === null) return { ...common, action: 'adopt', reason: 'epoch-baseline' };
  if (!sameSession) return { ...common, action: 'adopt', reason: 'epoch-other-session' };
  if (cur < st.lastEpoch) return { ...common, action: 'adopt', reason: 'epoch-reset' };
  if (cur > st.lastEpoch) return { ...common, action: 'force', reason: 'compact-detected' };
  return { ...common, action: 'threshold', reason: 'epoch-same' };
}

/** reinjectDecide 的布尔版：最终该不该注入。 */
export function reinjectShouldInject(dir, opts = {}) {
  const d = reinjectDecide(dir, opts);
  return d.action === 'force' ? true : Boolean(d.base?.inject);
}

/**
 * 记账：把这一轮的结论落到 reflect-state.json 的 state.reinject[key]。
 *
 * 锁内重读-改-写（与 handoff.js 同一套纪律），只碰自己这个槽位。
 * 写失败不抛：宁可多注一次，也不让整层挂掉。
 *
 * @returns {object} 记账后的现状
 */
export function reinjectCommit(dir, { sessionId = null, epoch = null, key = 'selfNote', injected = false, forced = false, now = Date.now() } = {}) {
  const cur = Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
  const sid = sessionId ? String(sessionId) : null;
  if (cur === null) return reinjectState(dir, key);
  try {
    handoffUpdateState(dir, (state) => {
      const root = state[REINJECT_KEY] && typeof state[REINJECT_KEY] === 'object' && !Array.isArray(state[REINJECT_KEY])
        ? { ...state[REINJECT_KEY] }
        : {};
      const prev = slotOf(state, key);
      const next = { ...prev, lastEpoch: cur };
      if (sid) {
        if (prev.lastSessionId !== sid) {
          // 换会话：基线跟着换，上一个会话的强制记录不带过来。
          next.lastSessionId = sid;
          next.forcedAt = 0;
          next.forcedCount = 0;
        } else {
          next.lastSessionId = sid;
        }
      }
      if (injected) next.lastInjectedAt = now;
      if (forced) {
        next.forcedAt = now;
        next.forcedCount = (Number(prev.forcedCount) || 0) + 1;
      }
      state[REINJECT_KEY] = { ...root, [key]: next };
    });
  } catch (e) {
    process.stderr.write(`reinject: 状态写不进去（${e.message}），压缩后可能重复注入一次\n`);
  }
  return reinjectState(dir, key);
}
