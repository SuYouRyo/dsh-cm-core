// 同步回执（N-02 D3，2026-11-20）。
//
// 缺口原文（2026-11-09 §14.2 第 3 条）：
//   「git 同步没有回执 —— 『结果未知』被当成失败；push 半断（进程被杀、网络掉）
//    可能已经推上去了却被判为没同步，下一轮从头再推。」
//
// 参照实现 dsh-local-memory/src/archive-out.mjs 的头注写得很准：
//   「A missing receipt therefore means "unknown", never "archived".」
// 拿过来就是本模块的全部立场：**没有回执 = 结果未知**，不是失败，也不是成功。
//
// 为什么要三态而不是二态（这是本张单唯一需要想清楚的地方）：
//   同步是一个跨进程、跨机器的动作。发起之后、落地之前，本机看到的永远是「不知道」。
//   旧实现把这段混沌压成布尔：throw 了就是失败、没 throw 就是成功。
//   于是：
//     · push 成功但 stdout 没回来的那种（超时、被杀）→ 记失败 → 用户以为没同步、反复重推
//     · push 其实失败了但 socket 半断（远端已收包）→ 记成功 → 远端状态与本机认知分叉
//   两边的代价完全不同：前者是好几个小时的重复劳动，后者是「以为推上去了其实没有」。
//   所以回执要能同时表达「我发起了」「我拿到了明确结论」「我没拿到结论」。
//
// 落地形态：本机专属的 append-only jsonl（.sync-receipts.jsonl，进 LOCAL_ONLY，绝不同步）。
//   { t, op: 'push'|'pull', state: 'intent'|'ok'|'failed'|'unknown',
//     head: <动作发起时的本地 HEAD>, pushed: <推送成功后的 HEAD>, detail, pid, host }
//
// 幂等：同一 (op, head, state) 只记一次。重复记没意义 ——
// 回执描述的是「这个提交的这次动作」，不是「我试了几次」。重试次数另有 pushFailures 记。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const RECEIPT_FILE = '.sync-receipts.jsonl';
export const RECEIPT_STATES = Object.freeze(['intent', 'ok', 'failed', 'unknown']);

export function receiptPath(dir) {
  return path.join(dir, RECEIPT_FILE);
}

function readLines(dir) {
  const p = receiptPath(dir);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      // 半行（进程被杀时写了半截）不能污染整个账本：跳过即可。
      // 「有一条读不出来」不是「整个回执不存在」，所以不退回 unknown。
    }
  }
  return out;
}

/** 回执的唯一键：同一个提交的同一种状态只记一次。 */
export function receiptKey(rec) {
  return [rec.op || '', rec.head || '', rec.state || ''].join('|');
}

/**
 * 追加一条回执。
 * @returns {{record: object, duplicate: boolean}}
 */
export function appendReceipt(dir, rec, { now = Date.now() } = {}) {
  const record = {
    t: now,
    op: String(rec.op || 'push'),
    state: RECEIPT_STATES.includes(rec.state) ? rec.state : 'unknown',
    head: rec.head ? String(rec.head) : '',
    pushed: rec.pushed ? String(rec.pushed) : '',
    detail: rec.detail ? String(rec.detail).slice(0, 400) : '',
    pid: process.pid,
    host: safeHost(),
  };
  const existing = readLines(dir);
  const key = receiptKey(record);
  if (existing.some((r) => receiptKey(r) === key)) return { record, duplicate: true };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(receiptPath(dir), JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // 回执写不进去不能影响同步本身 —— 与 .sync-state.json 同一个立场。
    // 区别是：写失败时调用方会拿到 duplicate=false 但磁盘上没有，
    // 下次问状态仍然得到「未知」，比假装写过更安全。
  }
  return { record, duplicate: false };
}

export function readReceipts(dir) {
  return readLines(dir);
}

/** 某个动作最近一条回执（不论状态）。 */
export function lastReceipt(dir, op) {
  const list = readLines(dir).filter((r) => (r.op || 'push') === op);
  return list.length ? list[list.length - 1] : null;
}

/**
 * 同步结论判定 —— 本模块对外唯一该用的入口。
 *
 * 规则（每一条都对应一个真实踩过的坑）：
 *   1. 没有回执           → unknown（missing receipt = unknown）
 *   2. 最后一条是 ok      → ok
 *   3. 最后一条是 failed  → failed
 *   4. 最后一条是 unknown → unknown
 *   5. 最后一条是 intent（只发起、没落地）→ unknown。
 *      「进程死在 push 中途」是本机唯一能观测到的事实；
 *      它究竟推上去了没有，本机**不知道**。当成失败会重推，当成成功会漏推。
 *   6. 同一 head 有 ok，之后又出现 intent/unknown（重试）→ 仍取最新那条的状态，
 *      但把上一次成功的 okAt 一并带出来，供人判断「其实已经成功过一次」。
 *
 * @returns {{state: string, at: number|null, head: string, pushed: string, detail: string, okAt: number|null}}
 */
export function syncVerdict(dir, op = 'push') {
  const list = readLines(dir).filter((r) => (r.op || 'push') === op);
  if (!list.length) {
    return { state: 'unknown', at: null, head: '', pushed: '', detail: '没有回执（结果未知，不能当成已同步）', okAt: null };
  }
  const last = list[list.length - 1];
  const okRec = [...list].reverse().find((r) => r.state === 'ok') || null;
  let state = last.state;
  let detail = last.detail || '';
  if (state === 'intent') {
    state = 'unknown';
    detail = '只发起了、没拿到结论（进程中断或超时）——结果未知，不能当成已同步';
  }
  return {
    state,
    at: last.t || null,
    head: last.head || '',
    pushed: last.pushed || '',
    detail,
    okAt: okRec ? okRec.t || null : null,
  };
}

/**
 * 收尾「悬空意图」：上一次只写了 intent 就没了（进程被杀），
 * 这一轮启动时把它钉成 unknown —— 保留它是意图的证据，同时明确它没有结论。
 * @returns {number} 被收尾的条数
 */
export function closeDanglingIntents(dir, op = 'push', { now = Date.now() } = {}) {
  const list = readLines(dir);
  if (!list.length) return 0;
  const last = [...list].reverse().find((r) => (r.op || 'push') === op);
  if (!last || last.state !== 'intent') return 0;
  appendReceipt(dir, { op, state: 'unknown', head: last.head, detail: '上一轮只写了发起、没有落地（进程被杀或超时）' }, { now });
  return 1;
}

function safeHost() {
  try { return os.hostname(); } catch { return ''; }
}
