// life 行清扫（丙方案的第二道闸，2026-11-21）
//
// 为什么需要它：丙方案把 life 的写入路径改到本机专属文件（raw/events-life/ 等），
// 但**已经在跑的进程用着改代码之前的那份内存镜像**（ESM 模块 import 时求值一次），
// 它会继续往被追踪的 raw/events/*.jsonl 与 raw/session-scope.jsonl 追加 life 行。
// 实测：改了代码之后，旧 watcher 每分钟仍写 1~2 条回被追踪文件。
//
// 而远端 /srv/hub/memory.git 的 pre-receive 钩子只认字符串 "scope":"life"，
// 只要这次推送的新增 commit 里有任意一条，**整次推送**被拒（不是只丢那一行）。
//
// 所以同步链路里必须有这一道：**在 git add 之前**把被追踪文件里的 life 行搬到本机专属文件。
// 这样即使写侧还有漏网的旧进程，同步也永远不会因为 life 被拒 —— 从「靠写侧干净」
// 变成「读侧/推侧无论写侧多脏都能自愈」。
//
// 三条纪律（与一次性迁移脚本 life-split-migrate.mjs 同源，但这里是常驻版）：
//   ① 只搬 scope=life 的行，非 life 行逐字节不动（拼起来的 sha 前后相同才落盘）；
//   ② 搬走后原文件不许再留 life 字面量，目标文件必须收到行（数量双向核对）；
//   ③ 写临时文件 + rename，不就地截断 —— 中途崩了不留半个文件。
//
// 失败一律**不抛**（返回 {ok:false, reason}）：清扫是同步的旁路，它挂掉不该让整轮同步停摆；
// 但调用方要据此决定「这轮还推不推」。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  eventsDirOf,
  lifeEventsDirOf,
  impressionsFileOf,
  lifeImpressionsFileOf,
  sessionScopeFileOf,
  lifeSessionScopeFileOf
} from './paths.js';

export const LIFE_RE = /"scope"\s*:\s*"life"/;
export const SWEEP_VERSION = 1;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readLines(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.sweep-tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 数一个文件里有几行 life（不认识的行不算）。 */
export function countLifeLines(file) {
  const lines = readLines(file);
  if (!lines) return 0;
  let n = 0;
  for (const line of lines) if (line.trim() && LIFE_RE.test(line)) n += 1;
  return n;
}

/**
 * 把被追踪文件里的 life 行搬到本机专属文件。
 *
 * @param {string} dir 记忆库目录（.companion-memory）
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{ok: boolean, moved: number, files: string[], reason?: string}}
 *          moved = 本次搬走的行数（0 表示本来就干净，这是最常见的结局）
 */
export function sweepLifeLines(dir, opts = {}) {
  const dryRun = !!opts.dryRun;
  const jobs = [];

  // ① 原文层：raw/events/<月>.jsonl → raw/events-life/<月>.jsonl
  const evSrc = eventsDirOf(dir);
  const evDst = lifeEventsDirOf(dir);
  let names = [];
  try { names = fs.readdirSync(evSrc).filter((f) => f.endsWith('.jsonl')).sort(); } catch { names = []; }
  for (const name of names) jobs.push({ src: path.join(evSrc, name), dst: path.join(evDst, name) });

  // ② 印象层、③ 会话落定表
  jobs.push({ src: impressionsFileOf(dir), dst: lifeImpressionsFileOf(dir) });
  jobs.push({ src: sessionScopeFileOf(dir), dst: lifeSessionScopeFileOf(dir) });

  const files = [];
  let movedTotal = 0;
  for (const job of jobs) {
    let lines;
    try { lines = readLines(job.src); } catch (e) { return { ok: false, moved: movedTotal, files, reason: 'read-failed:' + (e && e.message) }; }
    if (!lines) continue;

    const keep = [];
    const moved = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (LIFE_RE.test(line)) moved.push(line); else keep.push(line);
    }
    if (!moved.length) continue;

    if (dryRun) { movedTotal += moved.length; files.push(path.relative(dir, job.src) + '(' + moved.length + ')'); continue; }

    const keepBefore = sha(keep.join('\n') + '\n');
    const prev = readLines(job.dst);
    const prevText = prev && prev.length ? prev.filter((l) => l.trim()).join('\n') + '\n' : '';
    try {
      writeAtomic(job.dst, prevText + moved.join('\n') + '\n');
      writeAtomic(job.src, keep.length ? keep.join('\n') + '\n' : '');
    } catch (e) {
      return { ok: false, moved: movedTotal, files, reason: 'write-failed:' + (e && e.message) };
    }

    // ① 非 life 行逐字节不变
    const after = readLines(job.src) || [];
    const keepAfter = sha(after.filter((l) => l.trim()).join('\n') + '\n');
    if (keepAfter !== keepBefore) {
      return { ok: false, moved: movedTotal, files, reason: 'nonlife-changed:' + path.relative(dir, job.src) };
    }
    // ② 目标文件确实收到了这些行
    for (const line of moved) {
      if (!fs.readFileSync(job.dst, 'utf8').includes(line)) {
        return { ok: false, moved: movedTotal, files, reason: 'dst-missing:' + path.relative(dir, job.dst) };
      }
    }

    movedTotal += moved.length;
    files.push(path.relative(dir, job.src) + '(' + moved.length + ')');
  }

  return { ok: true, moved: movedTotal, files };
}

/**
 * 复核：被追踪的那几个文件里还有没有 life 行。
 * 供 doPush/doPull 在 add 之后、commit 之前做最后一道确认（防「清扫与写回」竞态）。
 */
export function trackedLifeRemaining(dir) {
  const out = [];
  const evSrc = eventsDirOf(dir);
  let names = [];
  try { names = fs.readdirSync(evSrc).filter((f) => f.endsWith('.jsonl')); } catch { names = []; }
  for (const n of names) {
    const n2 = countLifeLines(path.join(evSrc, n));
    if (n2) out.push({ file: 'raw/events/' + n, life: n2 });
  }
  const imp = countLifeLines(impressionsFileOf(dir));
  if (imp) out.push({ file: 'impressions/impressions.jsonl', life: imp });
  const ss = countLifeLines(sessionScopeFileOf(dir));
  if (ss) out.push({ file: 'raw/session-scope.jsonl', life: ss });
  return out;
}
